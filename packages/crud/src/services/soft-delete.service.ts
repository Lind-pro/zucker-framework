import { Injectable, NotFoundException, Inject, Optional } from '@nestjs/common';
import { type DatabaseAdapter, type GenericEntity } from '@zucker-framework/core';
import {
  EntityEventType,
  EntityEventPhase,
  type TopicEventBus,
  TOPIC_EVENT_BUS,
} from '@zucker-framework/event';
import { BaseService, type CrudQueryOptions } from '../base.service';
import { DynamicQueryService, type DynamicQueryParam } from '../dynamic-query.service';
import { activeAdapter } from './soft-delete-adapter';
import { transactionScoped } from '../transaction-scope';
import { DATABASE_ADAPTER } from '../crud.module';

/** 支持软删除的实体接口 */
export interface SoftDeletableEntity extends GenericEntity {
  deletedAt?: Date | null;
}

/** 软删除查询选项 */
export interface SoftDeleteQueryOptions extends CrudQueryOptions {
  includeDeleted?: boolean;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code;
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
  private readonly unscopedDb: DatabaseAdapter;

  constructor(
    @Inject(DATABASE_ADAPTER) unscopedDb: DatabaseAdapter,
    dynamicQuery: DynamicQueryService,
    modelName: string,
    @Optional() @Inject(TOPIC_EVENT_BUS) eventBus?: TopicEventBus,
    options?: { defaultOrderField?: string },
  ) {
    const scoped = transactionScoped(unscopedDb);
    super(activeAdapter(scoped, modelName), dynamicQuery, modelName, eventBus, options);
    this.unscopedDb = scoped;
  }

  protected override transactionView(tx: DatabaseAdapter): DatabaseAdapter {
    return activeAdapter(tx, this.modelName);
  }

  private assertId(id: string): void {
    if (!id || typeof id !== 'string' || id.trim().length === 0) {
      throw new NotFoundException(`${this.modelName}: ID must not be empty`);
    }
  }

  protected override get requiredQueryWhere(): Record<string, unknown> { return { deletedAt: null }; }

  /** 查询单条记录（自动排除已删除） */
  override async findOne(id: string, options?: SoftDeleteQueryOptions): Promise<T> {
    this.assertId(id);
    const entity = await this.unscopedDb.model(this.modelName).findUnique({
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
    const policy = this.queryPolicy;
    return this.dynamicQuery.findMany<T>(this.modelName, query, this.defaultOrderField,
      options?.dataAccessTerms, options?.denyFields,
      options?.includeDeleted ? undefined : this.requiredQueryWhere,
      ...(policy ? [{ policy }] : []));
  }

  /**
   * 执行软删除（设置 deletedAt）
   * BEFORE 阶段检查取消标志，支持监听器取消删除操作
   */
  override async delete(id: string): Promise<T> {
    const entity = await this.findOne(id);
    // PREPARE / BEFORE 阶段：监听器可 cancel() 取消删除操作
    await this.emitPrepareAndBefore(EntityEventType.DELETE, entity);

    let result: T;
    try {
      result = await this.unscopedDb.model(this.modelName).update({
        where: { id, deletedAt: null },
        data: { deletedAt: new Date() },
      }) as T;
    } catch (error) {
      // A concurrent delete removed the active row between the probe and the update.
      if (hasErrorCode(error, 'P2025')) throw new NotFoundException(`${this.modelName} with ID "${id}" not found`);
      throw error;
    }

    await this.emitEvent(EntityEventType.DELETE, EntityEventPhase.AFTER, result);
    return result;
  }

  /** 批量软删除 */
  override async deleteMany(where: Record<string, unknown>, options?: SoftDeleteQueryOptions): Promise<{ count: number }> {
    const softDeleteFilter = options?.includeDeleted ? {} : { deletedAt: null };
    return this.unscopedDb.model(this.modelName).updateMany({
      where: { AND: [where, softDeleteFilter] },
      data: { deletedAt: new Date() },
    });
  }

  /** 恢复已删除记录 */
  override async restore(id: string): Promise<T> {
    this.assertId(id);
    // 临时包含已删除记录来查找
    const entity = await this.unscopedDb.model(this.modelName).findUnique({
      where: { id },
    });

    if (!entity) {
      throw new NotFoundException(`${this.modelName} with ID "${id}" not found`);
    }

    return this.unscopedDb.model(this.modelName).update({
      where: { id, deletedAt: (entity as SoftDeletableEntity).deletedAt ?? null },
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
    const entity = await this.findOne(id, { includeDeleted: true });
    await this.emitPrepareAndBefore(EntityEventType.DELETE, entity);
    const result = await this.unscopedDb.model(this.modelName).delete({ where: { id } }) as T;
    await this.emitEvent(EntityEventType.DELETE, EntityEventPhase.AFTER, result);
    return result;
  }

  override async softDelete(id: string): Promise<T> { return this.delete(id); }
}
