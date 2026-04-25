import { Injectable, NotFoundException, Inject, Optional } from '@nestjs/common';
import { type DatabaseAdapter, type GenericEntity } from '@zucker/core';
import {
  EntityEventType,
  EntityEventPhase,
  type TopicEventBus,
  TOPIC_EVENT_BUS,
} from '@zucker/event';
import { BaseService } from '../base.service';
import { DynamicQueryService, type DynamicQueryParam } from '../dynamic-query.service';
import { DATABASE_ADAPTER } from '../crud.module';

/** 支持软删除的实体接口 */
export interface SoftDeletableEntity extends GenericEntity {
  deletedAt?: Date | null;
}

/** 软删除查询选项 */
export interface SoftDeleteQueryOptions {
  includeDeleted?: boolean;
}

/**
 * 软删除服务
 * - 所有查询自动加 WHERE deletedAt IS NULL 条件
 * - delete() 执行软删除而非物理删除
 * - 通过 options.includeDeleted 参数临时包含已删除记录
 * - restore(id) 恢复已删除记录
 */
@Injectable()
export abstract class SoftDeleteService<T extends SoftDeletableEntity> extends BaseService<T> {
  constructor(
    @Inject(DATABASE_ADAPTER) db: DatabaseAdapter,
    dynamicQuery: DynamicQueryService,
    modelName: string,
    @Optional() @Inject(TOPIC_EVENT_BUS) eventBus?: TopicEventBus,
    options?: { defaultOrderField?: string },
  ) {
    super(db, dynamicQuery, modelName, eventBus, options);
  }

  /** 查询单条记录（自动排除已删除） */
  override async findOne(id: string, options?: SoftDeleteQueryOptions): Promise<T> {
    const entity = await this.db.model(this.modelName).findUnique({
      where: { id },
    });

    if (!entity) {
      throw new NotFoundException(`${this.modelName} with ID "${id}" not found`);
    }

    // 检查是否已软删除
    if (!options?.includeDeleted && (entity as SoftDeletableEntity).deletedAt) {
      throw new NotFoundException(`${this.modelName} with ID "${id}" not found`);
    }

    return entity as T;
  }

  /** 分页查询（自动排除已删除） */
  override async findAll(query: DynamicQueryParam, options?: SoftDeleteQueryOptions) {
    // 在 filters 中注入软删除条件
    const enhancedQuery = this.injectSoftDeleteFilter(query, options);
    return super.findAll(enhancedQuery);
  }

  /**
   * 执行软删除（设置 deletedAt）
   * 对齐 hsweb: BEFORE 阶段使用 cancel check，支持监听器取消删除操作
   */
  override async delete(id: string): Promise<T> {
    const entity = await this.findOne(id);
    // BEFORE 阶段：监听器可 cancel() 取消删除操作（对齐 hsweb CrudService.deleteById）
    await this.emitEventWithCancelCheck(EntityEventType.DELETE, entity);

    const result = await this.db.model(this.modelName).update({
      where: { id },
      data: { deletedAt: new Date() },
    }) as T;

    await this.emitEvent(EntityEventType.DELETE, EntityEventPhase.AFTER, result);
    return result;
  }

  /** 批量软删除 */
  override async deleteMany(where: Record<string, unknown>, options?: SoftDeleteQueryOptions): Promise<{ count: number }> {
    const softDeleteFilter = options?.includeDeleted ? {} : { deletedAt: null };
    return this.db.model(this.modelName).updateMany({
      where: { ...where, ...softDeleteFilter },
      data: { deletedAt: new Date() },
    });
  }

  /** 恢复已删除记录 */
  override async restore(id: string): Promise<T> {
    // 临时包含已删除记录来查找
    const entity = await this.db.model(this.modelName).findUnique({
      where: { id },
    });

    if (!entity) {
      throw new NotFoundException(`${this.modelName} with ID "${id}" not found`);
    }

    return this.db.model(this.modelName).update({
      where: { id },
      data: { deletedAt: null },
    }) as Promise<T>;
  }

  /**
   * @deprecated Use `findAll(query, { includeDeleted: true })` or
   * `findOne(id, { includeDeleted: true })` instead.
   * This method uses Object.create(this) which causes shared mutable state bugs.
   */
  withDeleted(): this {
    const proxy = Object.create(this) as this;
    (proxy as unknown as Record<string, boolean>)._deprecatedIncludeDeleted = true;
    return proxy;
  }

  /**
   * 物理删除（真正从数据库删除）
   */
  async forceDelete(id: string): Promise<T> {
    return super.delete(id);
  }

  /** 在查询参数中注入软删除过滤条件 */
  private injectSoftDeleteFilter(query: DynamicQueryParam, options?: SoftDeleteQueryOptions): DynamicQueryParam {
    if (options?.includeDeleted) return query;

    // 将 deletedAt$isNull 注入到 filters 中
    let filters: Record<string, unknown> = {};
    if (query.filters) {
      try {
        filters = JSON.parse(query.filters);
      } catch {
        filters = {};
      }
    }

    filters['deletedAt$isNull'] = true;

    return {
      ...query,
      filters: JSON.stringify(filters),
    };
  }
}
