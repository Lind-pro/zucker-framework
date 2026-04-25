import { Injectable, NotFoundException, Logger, Inject, Optional } from '@nestjs/common';
import { type DatabaseAdapter, type GenericEntity, type Term, OperationCancelledException } from '@zucker/core';
import {
  EntityEventType,
  EntityEventPhase,
  createEntityEvent,
  getEntityEventName,
  isEntityEventEnabled,
  isDoFireEvent,
  type EntityEvent,
  type TopicEventBus,
  TOPIC_EVENT_BUS,
} from '@zucker/event';
import { DynamicQueryService, DynamicQueryParamService, type DynamicQueryParam } from './dynamic-query.service';
import { type PaginatedResult } from './pagination';
import { DATABASE_ADAPTER } from './crud.module';
import { QueryBuilder, type IQueryBuilder } from './query/query-builder';

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code: unknown }).code === code;
}

/**
 * Abstract base service providing standard CRUD operations with entity event support.
 * Mirrors hsweb CrudService with PREPARE/BEFORE/AFTER event lifecycle.
 *
 * Subclasses should provide the model name and optionally customize the default order field.
 *
 * @template T - The entity type, must extend GenericEntity
 */
@Injectable()
export abstract class BaseService<T extends GenericEntity> {
  protected readonly logger = new Logger(this.constructor.name);
  protected readonly modelName: string;
  protected readonly defaultOrderField: string = 'createdAt';

  constructor(
    @Inject(DATABASE_ADAPTER) protected readonly db: DatabaseAdapter,
    protected readonly dynamicQuery: DynamicQueryService,
    modelName: string,
    @Optional() @Inject(TOPIC_EVENT_BUS) protected readonly eventBus?: TopicEventBus,
    options?: { defaultOrderField?: string },
  ) {
    this.modelName = modelName;
    if (options?.defaultOrderField) {
      this.defaultOrderField = options.defaultOrderField;
    }
  }

  /**
   * 创建记录
   * 对齐 hsweb CrudService.insert(E)
   * @param data 实体数据
   * @returns 创建后的完整实体
   */
  async create(data: Partial<T>): Promise<T> {
    // PREPARE 阶段：监听器可修改 data 字段（如自动填充 creatorId）
    await this.emitEvent(EntityEventType.CREATE, EntityEventPhase.PREPARE, data);
    // BEFORE 阶段：监听器可 cancel() 取消操作
    await this.emitEventWithCancelCheck(EntityEventType.CREATE, data);

    const result = await this.db.model(this.modelName).create({ data }) as T;

    await this.emitEvent(EntityEventType.CREATE, EntityEventPhase.AFTER, result);
    return result;
  }

  /**
   * 根据 ID 更新记录
   * 对齐 hsweb CrudService.updateById(K, E)
   * @param id 记录 ID
   * @param data 要更新的字段
   * @returns 更新后的完整实体
   * @throws NotFoundException 记录不存在时
   */
  async update(id: string, data: Partial<T>): Promise<T> {
    // PREPARE 阶段：监听器可修改 data 字段
    await this.emitEvent(EntityEventType.MODIFY, EntityEventPhase.PREPARE, data);
    // BEFORE 阶段：监听器可 cancel() 取消操作
    await this.emitEventWithCancelCheck(EntityEventType.MODIFY, data);

    try {
      const result = await this.db.model(this.modelName).update({
        where: { id },
        data,
      }) as T;

      await this.emitEvent(EntityEventType.MODIFY, EntityEventPhase.AFTER, result);
      return result;
    } catch (error) {
      if (hasErrorCode(error, 'P2025')) {
        throw new NotFoundException(`${this.modelName} with ID "${id}" not found`);
      }
      throw error;
    }
  }

  /**
   * 保存或更新单条记录 — 有 ID 则 update，无 ID 则 create
   * 对齐 hsweb EntitySavedEvent / EntityBeforeSaveEvent 事件
   * @param data 实体数据
   * @returns 保存后的完整实体
   */
  async saveOrUpdate(data: Partial<T>): Promise<T> {
    // PREPARE 阶段（save 语义）
    await this.emitEvent(EntityEventType.SAVE, EntityEventPhase.PREPARE, data);
    // BEFORE 阶段
    await this.emitEventWithCancelCheck(EntityEventType.SAVE, data);

    const id = data.id;
    let result: T;
    if (id) {
      // update 路径 — 跳过 update 自身的事件（已在 save 层级发出）
      try {
        result = await this.db.model(this.modelName).update({
          where: { id },
          data,
        }) as T;
      } catch (error) {
        if (hasErrorCode(error, 'P2025')) {
          throw new NotFoundException(`${this.modelName} with ID "${id}" not found`);
        }
        throw error;
      }
    } else {
      result = await this.db.model(this.modelName).create({ data }) as T;
    }

    // AFTER 阶段（save 语义）
    await this.emitEvent(EntityEventType.SAVE, EntityEventPhase.AFTER, result);
    return result;
  }

  /**
   * 根据 ID 删除记录
   * 对齐 hsweb CrudService.deleteById(K)
   * @param id 记录 ID
   * @returns 被删除的实体
   * @throws NotFoundException 记录不存在时
   */
  async delete(id: string): Promise<T> {
    const entity = await this.findOne(id);
    // PREPARE 阶段：监听器可修改实体数据（如审计记录）— 对齐 hsweb 三阶段事件
    await this.emitEvent(EntityEventType.DELETE, EntityEventPhase.PREPARE, entity);
    // BEFORE 阶段：监听器可 cancel() 取消删除操作
    await this.emitEventWithCancelCheck(EntityEventType.DELETE, entity);

    try {
      const result = await this.db.model(this.modelName).delete({
        where: { id },
      }) as T;

      await this.emitEvent(EntityEventType.DELETE, EntityEventPhase.AFTER, result);
      return result;
    } catch (error) {
      if (hasErrorCode(error, 'P2025')) {
        throw new NotFoundException(`${this.modelName} with ID "${id}" not found`);
      }
      throw error;
    }
  }

  /**
   * 根据 ID 查询单条记录
   * 对齐 hsweb CrudService.findById(K)
   * @param id 记录 ID
   * @returns 查询到的实体
   * @throws NotFoundException 记录不存在时
   */
  async findOne(id: string): Promise<T> {
    if (!id || typeof id !== 'string' || id.trim().length === 0) {
      throw new NotFoundException(`${this.modelName}: ID must not be empty`);
    }
    const entity = await this.db.model(this.modelName).findUnique({
      where: { id },
    });

    if (!entity) {
      throw new NotFoundException(`${this.modelName} with ID "${id}" not found`);
    }

    return entity as T;
  }

  /**
   * 动态条件查询（带分页）
   * 对齐 hsweb CrudService.query(QueryParamEntity)
   * @param query 动态查询参数
   * @returns 分页查询结果
   */
  async findAll(query: DynamicQueryParam): Promise<PaginatedResult<T>> {
    return this.dynamicQuery.findMany<T>(this.modelName, query, this.defaultOrderField);
  }

  /**
   * 根据 ID 查询，返回 null 而不抛异常
   * 对齐 hsweb CrudService.findById(K) 返回 Optional<E> 的语义
   * @param id 记录 ID
   * @returns 实体或 null（不存在时返回 null）
   */
  async findByIdOptional(id: string): Promise<T | null> {
    if (!id || typeof id !== 'string' || id.trim().length === 0) {
      return null;
    }
    const entity = await this.db.model(this.modelName).findUnique({
      where: { id },
    });
    return (entity as T) ?? null;
  }

  /**
   * 根据 ID 列表批量查询
   * 对齐 hsweb CrudService.findById(Collection<K>)
   */
  async findByIds(ids: string[]): Promise<T[]> {
    if (ids.length === 0) return [];
    return this.db.model(this.modelName).findMany({
      where: { id: { in: ids } },
    }) as Promise<T[]>;
  }

  /**
   * 查询总数
   * 对齐 hsweb CrudService.count(QueryParam)
   */
  async count(where?: Record<string, unknown>): Promise<number> {
    return this.db.model(this.modelName).count({ where: where ?? {} });
  }

  /**
   * 根据动态查询参数查询总数
   * 对齐 hsweb CrudService.count(QueryParamEntity)
   */
  async countByQuery(query: DynamicQueryParam): Promise<number> {
    // 使用 DynamicQueryParamService.parseFilters 解析，确保与 findMany 的过滤逻辑一致
    const result = await this.dynamicQuery.findMany(this.modelName, {
      ...query,
      page: 1,
      pageSize: 1,
      total: undefined,
    }, this.defaultOrderField);
    return result.total;
  }

  /**
   * 判断数据是否存在
   * 对齐 hsweb ReactiveServiceQueryController._exists
   */
  async exists(query: DynamicQueryParam): Promise<boolean> {
    const result = await this.dynamicQuery.findMany(this.modelName, {
      ...query,
      page: 1,
      pageSize: 1,
    }, this.defaultOrderField);
    return result.data.length > 0;
  }

  /**
   * 分页查询 — 对齐 hsweb CrudService.queryPager() 语义
   * - 如果 param.total 已设置（前端传入），跳过 count 查询
   * - count 为 0 时直接返回空结果
   * - 自动调用 rePaging 修正越界页码
   */
  async queryPager(param: DynamicQueryParam): Promise<PaginatedResult<T>> {
    // 支持 pageIndex (0-based) 和 page (1-based)
    const resolvedPage = param.pageIndex !== undefined ? param.pageIndex + 1 : (param.page ?? 1);
    const page = Math.max(1, resolvedPage);
    const pageSize = Math.max(1, param.pageSize ?? 10);

    // total 复用：前端传了 total 就跳过 count 查询（对齐 hsweb queryPager）
    let total: number;
    if (param.total !== undefined && param.total !== null) {
      total = param.total;
    } else {
      // 通过 DynamicQueryParamService 解析过滤条件，避免原始 JSON 直接注入查询
      const countResult = await this.dynamicQuery.findMany(this.modelName, {
        ...param, page: 1, pageSize: 1, total: undefined,
      }, this.defaultOrderField);
      total = countResult.total;
    }

    if (total === 0) {
      return { data: [], total: 0, page, pageSize, totalPages: 0, pageIndex: page - 1 };
    }

    // rePaging：修正越界页码
    const totalPages = Math.ceil(total / pageSize);
    const adjustedPage = page > totalPages && totalPages > 0 ? totalPages : page;

    return this.dynamicQuery.findMany<T>(
      this.modelName,
      { ...param, page: adjustedPage, pageSize, total },
      this.defaultOrderField,
    );
  }

  /**
   * 批量保存（upsert 语义）
   * 对齐 hsweb CrudService.save(Collection<E>) — 有 ID 则 update，无 ID 则 create
   * 发出 SAVE 类型事件（EntityBeforeSaveEvent / EntitySavedEvent）
   * @returns SaveResult { created: number, updated: number, total: number }
   */
  async save(entities: Partial<T>[]): Promise<{ created: number; updated: number; total: number }> {
    if (!entities || entities.length === 0) return { created: 0, updated: 0, total: 0 };

    // PREPARE 阶段（save 语义）
    await this.emitEvent(EntityEventType.SAVE, EntityEventPhase.PREPARE, entities);
    // BEFORE 阶段
    await this.emitEventWithCancelCheck(EntityEventType.SAVE, entities);

    let created = 0;
    let updated = 0;

    // Batch existence check: collect all IDs and query once to avoid N+1
    const idsToCheck = entities.map((e) => e.id).filter((id): id is string => !!id);
    const existingIds = new Set<string>();
    if (idsToCheck.length > 0) {
      const existingRecords = await this.db.model(this.modelName).findMany({
        where: { id: { in: idsToCheck } },
        select: { id: true },
      }) as Array<{ id: string }>;
      for (const record of existingRecords) {
        existingIds.add(record.id);
      }
    }

    const results: T[] = [];
    for (const entity of entities) {
      const id = entity.id;
      if (id && existingIds.has(id)) {
        const result = await this.db.model(this.modelName).update({
          where: { id },
          data: entity,
        }) as T;
        results.push(result);
        updated++;
      } else {
        const result = await this.db.model(this.modelName).create({ data: entity }) as T;
        results.push(result);
        created++;
      }
    }

    // AFTER 阶段
    await this.emitEvent(EntityEventType.SAVE, EntityEventPhase.AFTER, results);

    return { created, updated, total: created + updated };
  }

  /**
   * 批量创建记录（不触发事件）
   * @param data 实体数据数组
   * @returns 创建数量
   */
  async createMany(data: Partial<T>[]): Promise<{ count: number }> {
    if (!data || data.length === 0) return { count: 0 };
    return this.db.model(this.modelName).createMany({ data });
  }

  /**
   * 按条件批量更新记录
   * @param where 过滤条件
   * @param data 要更新的字段
   * @returns 更新数量
   */
  async updateMany(where: Record<string, unknown>, data: Partial<T>): Promise<{ count: number }> {
    return this.db.model(this.modelName).updateMany({ where, data });
  }

  /**
   * 按条件批量删除记录
   * @param where 过滤条件
   * @returns 删除数量
   */
  async deleteMany(where: Record<string, unknown>): Promise<{ count: number }> {
    return this.db.model(this.modelName).deleteMany({ where });
  }

  /**
   * 软删除（设置 deletedAt 字段）
   * @param id 记录 ID
   * @returns 更新后的实体
   */
  async softDelete(id: string): Promise<T> {
    return this.update(id, { deletedAt: new Date() } as unknown as Partial<T>);
  }

  /**
   * 恢复软删除的记录（清除 deletedAt 字段）
   * @param id 记录 ID
   * @returns 恢复后的实体
   */
  async restore(id: string): Promise<T> {
    return this.update(id, { deletedAt: null } as unknown as Partial<T>);
  }

  /** 创建链式查询构建器 */
  createQuery(): IQueryBuilder<T> {
    return new QueryBuilder<T>(this.db, this.modelName);
  }

  /**
   * 乐观锁批量更新
   * 使用 updatedAt 作为版本号，只有 updatedAt 匹配时才执行更新
   * @param items 待更新的记录数组，每条记录必须包含 id 和 updatedAt
   * @returns { count: 成功更新数, failed: 冲突记录数组 }
   */
  async updateManyWithOptimisticLock(
    items: Array<Partial<T> & { id: string; updatedAt: Date }>,
  ): Promise<{ count: number; failed: T[] }> {
    if (!items || items.length === 0) return { count: 0, failed: [] };

    const failed: T[] = [];
    let count = 0;

    // 逐条更新，使用 updatedAt 作为乐观锁条件
    for (const item of items) {
      const { id, updatedAt, ...data } = item;
      try {
        const result = await this.db.model(this.modelName).updateMany({
          where: { id, updatedAt },
          data,
        });

        if (result.count === 0) {
          // 版本冲突：记录已被其他事务修改
          try {
            const current = await this.db.model(this.modelName).findUnique({ where: { id } });
            if (current) {
              failed.push(current as T);
            }
          } catch {
            // 记录可能已被删除，跳过
          }
        } else {
          count += result.count;
        }
      } catch (error) {
        // 记录不存在或其他错误
        this.logger.warn(`乐观锁更新失败 id=${id}: ${(error as Error).message}`);
        try {
          const current = await this.db.model(this.modelName).findUnique({ where: { id } });
          if (current) {
            failed.push(current as T);
          }
        } catch {
          // ignore
        }
      }
    }

    return { count, failed };
  }

  /**
   * 批量创建（带事件）
   */
  async createBatch(items: Partial<T>[], options?: { skipEvents?: boolean }): Promise<T[]> {
    if (!items || items.length === 0) return [];
    const results: T[] = [];
    for (const item of items) {
      if (!options?.skipEvents) {
        await this.emitEvent(EntityEventType.CREATE, EntityEventPhase.PREPARE, item);
        await this.emitEventWithCancelCheck(EntityEventType.CREATE, item);
      }

      const result = await this.db.model(this.modelName).create({ data: item }) as T;
      results.push(result);

      if (!options?.skipEvents) {
        await this.emitEvent(EntityEventType.CREATE, EntityEventPhase.AFTER, result);
      }
    }
    return results;
  }

  /**
   * 批量更新（带事件）
   */
  async updateBatch(items: (Partial<T> & { id: string })[], options?: { skipEvents?: boolean }): Promise<T[]> {
    if (!items || items.length === 0) return [];
    const results: T[] = [];
    for (const item of items) {
      const { id, ...data } = item;

      if (!options?.skipEvents) {
        await this.emitEvent(EntityEventType.MODIFY, EntityEventPhase.PREPARE, data);
        await this.emitEventWithCancelCheck(EntityEventType.MODIFY, data);
      }

      try {
        const result = await this.db.model(this.modelName).update({
          where: { id },
          data,
        }) as T;
        results.push(result);

        if (!options?.skipEvents) {
          await this.emitEvent(EntityEventType.MODIFY, EntityEventPhase.AFTER, result);
        }
      } catch (error) {
        if (hasErrorCode(error, 'P2025')) {
          throw new NotFoundException(`${this.modelName} with ID "${id}" not found`);
        }
        throw error;
      }
    }
    return results;
  }

  /**
   * 批量删除（带事件）
   */
  async deleteBatch(ids: string[], options?: { skipEvents?: boolean }): Promise<number> {
    if (!ids || ids.length === 0) return 0;

    // Batch-fetch all entities upfront to avoid N+1 findUnique calls
    const entities = await this.db.model(this.modelName).findMany({
      where: { id: { in: ids } },
    }) as T[];
    const entityMap = new Map<string, T>();
    for (const entity of entities) {
      entityMap.set((entity as GenericEntity).id, entity);
    }

    let count = 0;
    for (const id of ids) {
      try {
        const entity = entityMap.get(id);
        if (!entity) continue;

        if (!options?.skipEvents) {
          await this.emitEvent(EntityEventType.DELETE, EntityEventPhase.PREPARE, entity);
          await this.emitEventWithCancelCheck(EntityEventType.DELETE, entity);
        }

        await this.db.model(this.modelName).delete({ where: { id } });
        count++;

        if (!options?.skipEvents) {
          await this.emitEvent(EntityEventType.DELETE, EntityEventPhase.AFTER, entity);
        }
      } catch (error) {
        if (hasErrorCode(error, 'P2025')) continue;
        throw error;
      }
    }
    return count;
  }

  /**
   * 执行事务
   * @param fn 事务回调函数
   * @returns 事务执行结果
   */
  async transaction<R>(fn: (db: DatabaseAdapter) => Promise<R>): Promise<R> {
    return this.db.$transaction(fn);
  }

  protected async emitEvent(type: EntityEventType, phase: EntityEventPhase, entity: unknown): Promise<EntityEvent> {
    const event = createEntityEvent(type, phase, this.modelName, entity);
    if (!this.eventBus) return event;
    // 检查 EntityEventHelper 的 doFireEvent 上下文标志 — 对齐 hsweb EntityEventHelper.tryFireEvent
    if (!isDoFireEvent(true)) return event;
    // 检查 @EnableEntityEvent 装饰器配置
    if (!isEntityEventEnabled(this.constructor, type)) return event;
    const eventName = getEntityEventName(this.modelName, type, phase);
    await this.eventBus.publish(eventName, event);
    return event;
  }

  /**
   * 发出 BEFORE 阶段事件并检查是否被取消
   * 如果事件被取消，抛出 OperationCancelledException
   */
  protected async emitEventWithCancelCheck(type: EntityEventType, entity: unknown): Promise<void> {
    const event = await this.emitEvent(type, EntityEventPhase.BEFORE, entity);
    if (event?.cancelled) {
      throw new OperationCancelledException(
        event.cancelReason ?? `${this.modelName} ${type} operation cancelled`,
      );
    }
  }
}
