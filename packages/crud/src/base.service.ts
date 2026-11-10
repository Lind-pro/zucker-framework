import type { CrudEntity } from './crud-entity';
import { Injectable, NotFoundException, Logger, Inject, Optional } from '@nestjs/common';
import {
  type DatabaseAdapter,
  type Term,
  OperationCancelledException,
} from '@zucker-framework/core';
import {
  EntityEventType,
  EntityEventPhase,
  createEntityEvent,
  getEntityEventName,
  isEntityEventEnabled,
  markEntityIsNew,
  isDoFireEvent,
  type EntityEvent,
  type TopicEventBus,
  TOPIC_EVENT_BUS,
} from '@zucker-framework/event';
import {
  DynamicQueryService,
  type DynamicQueryParam,
  normalizeDynamicQueryParam,
} from './dynamic-query.service';
import { type CrudQueryPolicy } from './query/query-policy';
import { runInServiceTransaction, transactionScoped } from './transaction-scope';
import { type PaginatedResult } from './pagination';
import { DATABASE_ADAPTER } from './crud.module';
import { QueryBuilder, type IQueryBuilder } from './query/query-builder';

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === code
  );
}

/** Trusted, server-side options for the dynamic list/count/exists reads. */
export interface CrudQueryOptions {
  /** Row-level data-access terms (e.g. from DataPermissionGuard); ANDed with caller filters. */
  dataAccessTerms?: Term[];
  /** Fields the current principal may not read; removed from the projection. */
  denyFields?: string[];
}

/**
 * Abstract base service providing standard CRUD operations with entity event support.
 *
 * Subclasses should provide the model name and optionally customize the default order field.
 *
 * @template T - The entity type, must extend CrudEntity
 */
export abstract class CrudService<T extends CrudEntity> {
  protected readonly logger = new Logger(this.constructor.name);
  protected readonly modelName: string;
  /**
   * Database adapter. Model access follows an enclosing {@link transaction} call, so CRUD methods
   * of services sharing the same adapter join that transaction.
   */
  protected readonly db: DatabaseAdapter;
  /**
   * Trusted constraints (tenant / owner / active-record fence) independent of user filter syntax.
   * Applied to dynamic list/count/exists reads AND to by-ID reads, updates, deletes and batch writes.
   */
  protected get requiredQueryWhere(): Record<string, unknown> | undefined { return undefined; }

  /**
   * Field/operator/paging policy for caller-supplied dynamic queries; merged over the module
   * default (`ZuckerCrudModule.forRoot({ queryPolicy })`). See {@link CrudQueryPolicy}.
   */
  protected get queryPolicy(): CrudQueryPolicy | undefined { return undefined; }

  /**
   * The policy applied to caller input for this model (module default + {@link queryPolicy} +
   * adapter field metadata). Used by generated routes that validate caller input outside
   * dynamic queries, e.g. the batch `where`.
   */
  callerQueryPolicy(): CrudQueryPolicy {
    return this.dynamicQuery.callerPolicy(this.modelName, this.queryPolicy);
  }

  private findManyScoped<R = unknown>(
    model: string,
    query: DynamicQueryParam,
    order?: string,
    access?: CrudQueryOptions,
  ): Promise<PaginatedResult<R>> {
    const policy = this.queryPolicy;
    const required = this.requiredQueryWhere;
    if (!required && !policy && !access?.dataAccessTerms && !access?.denyFields) {
      return this.dynamicQuery.findMany<R>(model, query, order);
    }
    return this.dynamicQuery.findMany<R>(
      model, query, order, access?.dataAccessTerms, access?.denyFields, required,
      ...(policy ? [{ policy }] : []),
    );
  }

  /** AND the trusted constraint into a where (unique keys stay top-level for Prisma WhereUniqueInput). */
  protected scopeWhere(where: Record<string, unknown>): Record<string, unknown> {
    const required = this.requiredQueryWhere;
    if (!required || Object.keys(required).length === 0) return where;
    return { ...where, AND: [...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []), required] };
  }

  protected readonly defaultOrderField: string = 'createdAt';

  constructor(
    db: DatabaseAdapter,
    protected readonly dynamicQuery: DynamicQueryService,
    modelName: string,
    protected readonly eventBus?: TopicEventBus,
    options?: { defaultOrderField?: string },
  ) {
    this.db = transactionScoped(db);
    this.modelName = modelName;
    if (options?.defaultOrderField) {
      this.defaultOrderField = options.defaultOrderField;
    }
  }

  /**
   * 创建记录
   * @param data 实体数据
   * @returns 创建后的完整实体
   */
  async create(data: Partial<T>): Promise<T> {
    // PREPARE 阶段：监听器可修改 data 字段（如自动填充 creatorId）；BEFORE 阶段：监听器可 cancel()
    await this.emitPrepareAndBefore(EntityEventType.CREATE, data);

    const result = (await this.db.model(this.modelName).create({ data })) as T;

    await this.emitEvent(EntityEventType.CREATE, EntityEventPhase.AFTER, result);
    return result;
  }

  /**
   * 根据 ID 更新记录
   * @param id 记录 ID
   * @param data 要更新的字段
   * @returns 更新后的完整实体
   * @throws NotFoundException 记录不存在时
   */
  async update(id: string, data: Partial<T>): Promise<T> {
    // PREPARE 阶段：监听器可修改 data 字段；BEFORE 阶段：监听器可 cancel() 取消操作
    await this.emitPrepareAndBefore(EntityEventType.MODIFY, data);

    try {
      const result = (await this.db.model(this.modelName).update({
        where: this.scopeWhere({ id }),
        data,
      })) as T;

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
   * 发送保存操作的实体生命周期事件
   * @param data 实体数据
   * @returns 保存后的完整实体
   */
  async saveOrUpdate(data: Partial<T>): Promise<T> {
    // Existence probe before PREPARE, so listeners know whether a client-generated id is a
    // create (creator fields) or an update (modifier fields only).
    const id = data.id;
    const exists = id
      ? !!(await this.db.model(this.modelName).findUnique({ where: this.scopeWhere({ id }) }))
      : false;
    if (data && typeof data === 'object') markEntityIsNew(data, !exists);

    // PREPARE / BEFORE 阶段（save 语义）
    await this.emitPrepareAndBefore(EntityEventType.SAVE, data);

    let result: T;
    if (id && exists) {
      // update 路径 — 跳过 update 自身的事件（已在 save 层级发出）
      try {
        result = (await this.db.model(this.modelName).update({
          where: this.scopeWhere({ id }),
          data,
        })) as T;
      } catch (error) {
        if (hasErrorCode(error, 'P2025')) {
          throw new NotFoundException(`${this.modelName} with ID "${id}" not found`);
        }
        throw error;
      }
    } else {
      result = (await this.db.model(this.modelName).create({ data })) as T;
    }

    // AFTER 阶段（save 语义）
    await this.emitEvent(EntityEventType.SAVE, EntityEventPhase.AFTER, result);
    return result;
  }

  /**
   * 根据 ID 删除记录
   * @param id 记录 ID
   * @returns 被删除的实体
   * @throws NotFoundException 记录不存在时
   */
  async delete(id: string): Promise<T> {
    const entity = await this.findOne(id);
    // PREPARE 阶段：监听器可修改实体数据（如审计记录）；BEFORE 阶段：监听器可 cancel() 取消删除操作
    await this.emitPrepareAndBefore(EntityEventType.DELETE, entity);

    try {
      const result = (await this.db.model(this.modelName).delete({
        where: this.scopeWhere({ id }),
      })) as T;

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
   * @param id 记录 ID
   * @returns 查询到的实体
   * @throws NotFoundException 记录不存在时
   */
  async findOne(id: string): Promise<T> {
    if (!id || typeof id !== 'string' || id.trim().length === 0) {
      throw new NotFoundException(`${this.modelName}: ID must not be empty`);
    }
    const entity = await this.db.model(this.modelName).findUnique({
      where: this.scopeWhere({ id }),
    });

    if (!entity) {
      throw new NotFoundException(`${this.modelName} with ID "${id}" not found`);
    }

    return entity as T;
  }

  /**
   * 动态条件查询（带分页）
   * @param query 动态查询参数
   * @returns 分页查询结果
   */
  async findAll(query: DynamicQueryParam, options?: CrudQueryOptions): Promise<PaginatedResult<T>> {
    return this.findManyScoped<T>(this.modelName, query, this.defaultOrderField, options);
  }

  /**
   * 根据 ID 查询，返回 null 而不抛异常
   * 记录不存在时返回空值
   * @param id 记录 ID
   * @returns 实体或 null（不存在时返回 null）
   */
  async findByIdOptional(id: string): Promise<T | null> {
    if (!id || typeof id !== 'string' || id.trim().length === 0) {
      return null;
    }
    const entity = await this.db.model(this.modelName).findUnique({
      where: this.scopeWhere({ id }),
    });
    return (entity as T) ?? null;
  }

  /**
   * 根据 ID 列表批量查询
   */
  async findByIds(ids: string[]): Promise<T[]> {
    if (ids.length === 0) return [];
    return this.db.model(this.modelName).findMany({
      where: this.scopeWhere({ id: { in: ids } }),
    }) as Promise<T[]>;
  }

  /**
   * 查询总数
   */
  async count(where?: Record<string, unknown>): Promise<number> {
    return this.db.model(this.modelName).count({ where: this.scopeWhere(where ?? {}) });
  }

  /**
   * 根据动态查询参数查询总数
   */
  async countByQuery(query: DynamicQueryParam, options?: CrudQueryOptions): Promise<number> {
    // 使用 DynamicQueryParamService.parseFilters 解析，确保与 findMany 的过滤逻辑一致
    const result = await this.findManyScoped(
      this.modelName,
      {
        ...query,
        page: 1,
        pageSize: 1,
        total: undefined,
      },
      this.defaultOrderField,
      options,
    );
    return result.total;
  }

  /**
   * 判断数据是否存在
   */
  async exists(query: DynamicQueryParam, options?: CrudQueryOptions): Promise<boolean> {
    const result = await this.findManyScoped(
      this.modelName,
      {
        ...query,
        page: 1,
        pageSize: 1,
        // A caller-supplied total would skip nothing here but must not shape the probe.
        total: undefined,
      },
      this.defaultOrderField,
      options,
    );
    return result.data.length > 0;
  }

  /**
   * 分页查询
   * - 如果 param.total 已设置（前端传入），跳过 count 查询
   * - count 为 0 时直接返回空结果
   * - 自动调用 rePaging 修正越界页码
   */
  async queryPager(rawParam: DynamicQueryParam, options?: CrudQueryOptions): Promise<PaginatedResult<T>> {
    // GET query strings arrive as strings: coerce before arithmetic ("1" + 1 must not become "11").
    const param = normalizeDynamicQueryParam(rawParam);
    // 支持 pageIndex (0-based) 和 page (1-based)
    const resolvedPage = param.pageIndex !== undefined ? param.pageIndex + 1 : (param.page ?? 1);
    const page = Math.max(1, Math.floor(resolvedPage));
    // Clamp like findMany does, so page bounds (rePaging) are computed with the real page size.
    const pageSize = Math.min(
      this.dynamicQuery.maxPageSizeFor(this.queryPolicy),
      Math.max(1, Math.floor(param.pageSize ?? 10)),
    );

    // total 复用：前端传了 total 就跳过 count 查询
    let total: number;
    if (param.total !== undefined && param.total !== null) {
      total = param.total;
    } else {
      // 通过 DynamicQueryParamService 解析过滤条件，避免原始 JSON 直接注入查询
      const countResult = await this.findManyScoped(
        this.modelName,
        {
          ...param,
          page: 1,
          pageSize: 1,
          total: undefined,
        },
        this.defaultOrderField,
        options,
      );
      total = countResult.total;
    }

    if (total === 0) {
      return { data: [], total: 0, page, pageSize, totalPages: 0, pageIndex: page - 1 };
    }

    // rePaging：修正越界页码
    const totalPages = Math.ceil(total / pageSize);
    const adjustedPage = page > totalPages && totalPages > 0 ? totalPages : page;

    return this.findManyScoped<T>(
      this.modelName,
      { ...param, page: adjustedPage, pageSize, total },
      this.defaultOrderField,
      options,
    );
  }

  /**
   * 批量保存（upsert 语义）
   * 有 ID 则 update，无 ID 则 create
   * 发出 SAVE 类型事件（EntityBeforeSaveEvent / EntitySavedEvent）
   * @returns SaveResult { created: number, updated: number, total: number }
   */
  async save(entities: Partial<T>[]): Promise<{ created: number; updated: number; total: number }> {
    if (!entities || entities.length === 0) return { created: 0, updated: 0, total: 0 };

    // Batch existence check before PREPARE (one query, no N+1), so listeners fill creator
    // fields for new rows with client-generated ids.
    const idsToCheck = entities.map((e) => e.id).filter((id): id is string => !!id);
    const existingIds = new Set<string>();
    if (idsToCheck.length > 0) {
      const existingRecords = (await this.db.model(this.modelName).findMany({
        where: this.scopeWhere({ id: { in: idsToCheck } }),
        select: { id: true },
      })) as Array<{ id: string }>;
      for (const record of existingRecords) {
        existingIds.add(record.id);
      }
    }
    for (const entity of entities) {
      if (entity && typeof entity === 'object') markEntityIsNew(entity, !(entity.id && existingIds.has(entity.id)));
    }

    // PREPARE / BEFORE 阶段（save 语义）
    await this.emitPrepareAndBefore(EntityEventType.SAVE, entities);

    let created = 0;
    let updated = 0;

    const results: T[] = [];
    for (const entity of entities) {
      const id = entity.id;
      if (id && existingIds.has(id)) {
        const result = (await this.db.model(this.modelName).update({
          where: this.scopeWhere({ id }),
          data: entity,
        })) as T;
        results.push(result);
        updated++;
      } else {
        const result = (await this.db.model(this.modelName).create({ data: entity })) as T;
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
    return this.db.model(this.modelName).updateMany({ where: this.scopeBatchWhere(where), data });
  }

  /**
   * 按条件批量删除记录
   * @param where 过滤条件
   * @returns 删除数量
   */
  async deleteMany(where: Record<string, unknown>): Promise<{ count: number }> {
    return this.db.model(this.modelName).deleteMany({ where: this.scopeBatchWhere(where) });
  }

  /** AND the trusted constraint into a batch where without disturbing caller keys. */
  private scopeBatchWhere(where: Record<string, unknown>): Record<string, unknown> {
    const required = this.requiredQueryWhere;
    return required && Object.keys(required).length ? { AND: [where, required] } : where;
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
          where: this.scopeBatchWhere({ id, updatedAt }),
          data,
        });

        if (result.count === 0) {
          // 版本冲突：记录已被其他事务修改
          try {
            // Scoped: a foreign row (other owner / tenant) must not be returned as a conflict.
          const current = await this.db.model(this.modelName).findUnique({ where: this.scopeWhere({ id }) });
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
        // Only a missing record is a conflict; validation / connection errors must surface.
        if (!hasErrorCode(error, 'P2025')) throw error;
        this.logger.warn(`乐观锁更新失败 id=${id}: ${(error as Error).message}`);
        try {
          // Scoped: a foreign row (other owner / tenant) must not be returned as a conflict.
          const current = await this.db.model(this.modelName).findUnique({ where: this.scopeWhere({ id }) });
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
        await this.emitPrepareAndBefore(EntityEventType.CREATE, item);
      }

      const result = (await this.db.model(this.modelName).create({ data: item })) as T;
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
  async updateBatch(
    items: (Partial<T> & { id: string })[],
    options?: { skipEvents?: boolean },
  ): Promise<T[]> {
    if (!items || items.length === 0) return [];
    const results: T[] = [];
    for (const item of items) {
      const { id, ...data } = item;

      if (!options?.skipEvents) {
        await this.emitPrepareAndBefore(EntityEventType.MODIFY, data);
      }

      try {
        const result = (await this.db.model(this.modelName).update({
          where: this.scopeWhere({ id }),
          data,
        })) as T;
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
    const entities = (await this.db.model(this.modelName).findMany({
      where: this.scopeWhere({ id: { in: ids } }),
    })) as T[];
    const entityMap = new Map<string, T>();
    for (const entity of entities) {
      entityMap.set((entity as CrudEntity).id, entity);
    }

    let count = 0;
    for (const id of ids) {
      try {
        const entity = entityMap.get(id);
        if (!entity) continue;

        if (!options?.skipEvents) {
          await this.emitPrepareAndBefore(EntityEventType.DELETE, entity);
        }

        await this.db.model(this.modelName).delete({ where: this.scopeWhere({ id }) });
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
   *
   * While `fn` runs, CRUD methods of this service and of every other CrudService built on the same
   * DatabaseAdapter use the transaction client, so they commit or roll back together. Nested calls
   * join the outer transaction.
   * @param fn 事务回调函数（参数为本服务视角的事务 adapter）
   * @returns 事务执行结果
   */
  async transaction<R>(fn: (db: DatabaseAdapter) => Promise<R>): Promise<R> {
    return runInServiceTransaction(this.db, (tx) => fn(this.transactionView(tx)));
  }

  /** The adapter handed to {@link transaction} callbacks (subclasses may add scoping). */
  protected transactionView(tx: DatabaseAdapter): DatabaseAdapter {
    return tx;
  }

  protected async emitEvent(
    type: EntityEventType,
    phase: EntityEventPhase,
    entity: unknown,
  ): Promise<EntityEvent> {
    const event = createEntityEvent(type, phase, this.modelName, entity);
    if (!this.eventBus) return event;
    // 检查 EntityEventHelper 的 doFireEvent 上下文标志
    if (!isDoFireEvent(true)) return event;
    // 检查 @EnableEntityEvent 装饰器配置
    if (!isEntityEventEnabled(this.constructor, type)) return event;
    const eventName = getEntityEventName(this.modelName, type, phase);
    await this.eventBus.publish(eventName, event);
    return event;
  }

  /**
   * Emit PREPARE then BEFORE and stop the operation if either phase was cancelled
   * (e.g. by a validation listener). Subscriber errors marked with `vetoEvent()` propagate from
   * `publish()` and also abort the operation.
   */
  protected async emitPrepareAndBefore(type: EntityEventType, entity: unknown): Promise<void> {
    const prepared = await this.emitEvent(type, EntityEventPhase.PREPARE, entity);
    this.throwIfCancelled(prepared, type);
    await this.emitEventWithCancelCheck(type, entity);
  }

  private throwIfCancelled(event: EntityEvent | undefined, type: EntityEventType): void {
    if (event?.cancelled) {
      throw new OperationCancelledException(
        event.cancelReason ?? `${this.modelName} ${type} operation cancelled`,
      );
    }
  }

  /**
   * 发出 BEFORE 阶段事件并检查是否被取消
   * 如果事件被取消，抛出 OperationCancelledException
   */
  protected async emitEventWithCancelCheck(type: EntityEventType, entity: unknown): Promise<void> {
    const event = await this.emitEvent(type, EntityEventPhase.BEFORE, entity);
    this.throwIfCancelled(event, type);
  }
}

/** Nest-injected base retained for consumers whose constructor follows this signature.
 * Custom constructor layouts should extend CrudService and inject their own dependencies. */
@Injectable()
export abstract class BaseService<T extends CrudEntity> extends CrudService<T> {
  constructor(
    @Inject(DATABASE_ADAPTER) db: DatabaseAdapter,
    dynamicQuery: DynamicQueryService,
    modelName: string,
    @Optional() @Inject(TOPIC_EVENT_BUS) eventBus?: TopicEventBus,
    options?: { defaultOrderField?: string },
  ) {
    super(db, dynamicQuery, modelName, eventBus, options);
  }
}
