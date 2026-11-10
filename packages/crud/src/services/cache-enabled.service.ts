import { createHash } from 'node:crypto';
import { Injectable, Inject, Optional, Logger } from '@nestjs/common';
import { type GenericEntity, type DatabaseAdapter, TransactionHolder } from '@zucker-framework/core';
import { type ICache, CACHE_PROVIDER } from '@zucker-framework/cache';
import {
  EntityEventType,
  EntityEventPhase,
  type TopicEventBus,
  TOPIC_EVENT_BUS,
} from '@zucker-framework/event';
import { BaseService } from '../base.service';
import { DynamicQueryService, type DynamicQueryParam } from '../dynamic-query.service';
import { DATABASE_ADAPTER } from '../crud.module';

/** 缓存键前缀常量 */
const CACHE_PREFIX = 'crud:';

/** 默认缓存 TTL: 5 分钟 */
const DEFAULT_TTL_MS = 5 * 60 * 1000;

/** 全量缓存键前缀（与单条 ID 键分属不同命名空间，避免 ID 为 "@all" 时冲突） */
const ALL_CACHE_PREFIX = 'crud-all:';

export interface CacheEnabledServiceOptions {
  /** 缓存 TTL（毫秒） */
  ttlMs?: number;
  /** 默认排序字段 */
  defaultOrderField?: string;
}

/**
 * 带缓存的 CRUD 服务
 * - findOne/findById 自动读缓存、写缓存（带 TTL）
 * - update/delete 自动失效缓存，发布缓存清除事件
 */
@Injectable()
export abstract class CacheEnabledService<T extends GenericEntity> extends BaseService<T> {
  protected readonly cacheLogger = new Logger(this.constructor.name);
  protected readonly ttlMs: number;

  constructor(
    @Inject(DATABASE_ADAPTER) db: DatabaseAdapter,
    dynamicQuery: DynamicQueryService,
    modelName: string,
    @Inject(CACHE_PROVIDER) protected readonly cache: ICache,
    @Optional() @Inject(TOPIC_EVENT_BUS) eventBus?: TopicEventBus,
    options?: CacheEnabledServiceOptions,
  ) {
    super(db, dynamicQuery, modelName, eventBus, {
      defaultOrderField: options?.defaultOrderField,
    });
    this.ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
  }

  /**
   * 获取缓存名称
   */
  getCacheName(): string {
    return this.constructor.name;
  }

  /** 生成缓存键 */
  protected getCacheKey(id: string): string {
    return `${CACHE_PREFIX}${this.modelName}:id:${id}`;
  }

  /** 全量缓存键 */
  protected getAllCacheKey(): string {
    return `${ALL_CACHE_PREFIX}${this.modelName}`;
  }

  /** Cache writes are best-effort: a serialization or backend error must not fail the DB read. */
  private async safeCacheSet(key: string, value: unknown): Promise<void> {
    try {
      await this.cache.set(key, value, this.ttlMs);
    } catch (error) {
      this.cacheLogger.warn(`缓存写入失败: ${key}: ${(error as Error).message}`);
    }
  }

  /**
   * 获取全量数据（优先走缓存）
   * 适用于数据量较小的配置表、字典表等
   */
  async getCacheAll(): Promise<T[]> {
    const cacheKey = this.getAllCacheKey();

    const cached = await this.cache.get(cacheKey);
    if (cached) {
      this.cacheLogger.debug(`全量缓存命中: ${cacheKey}`);
      return cached as T[];
    }

    const all = await this.db.model(this.modelName).findMany({}) as T[];
    await this.safeCacheSet(cacheKey, all);
    this.cacheLogger.debug(`全量缓存写入: ${cacheKey}, count=${all.length}`);

    return all;
  }

  /**
   * 创建后失效全量缓存
   */
  override async create(data: Partial<T>): Promise<T> {
    const result = await super.create(data);
    await this.invalidateCache(result.id);
    return result;
  }

  /**
   * 批量保存后失效缓存
   */
  override async save(entities: Partial<T>[]): Promise<{ created: number; updated: number; total: number }> {
    const result = await super.save(entities);
    // 失效被更新记录的单条缓存 + 全量缓存
    const ids = entities.map((entity) => entity.id).filter((id): id is string => typeof id === 'string' && !!id);
    await this.invalidateCacheMany(ids);
    await this.invalidateAll();
    return result;
  }

  override async saveOrUpdate(data: Partial<T>): Promise<T> {
    const result = await super.saveOrUpdate(data);
    await this.invalidateCache(result.id);
    return result;
  }

  override async updateBatch(
    items: (Partial<T> & { id: string })[],
    options?: { skipEvents?: boolean },
  ): Promise<T[]> {
    const result = await super.updateBatch(items, options);
    await this.invalidateCacheMany(items.map((item) => item.id));
    return result;
  }

  override async restore(id: string): Promise<T> {
    const result = await super.restore(id);
    await this.invalidateCache(id);
    return result;
  }

  override async updateManyWithOptimisticLock(
    items: Array<Partial<T> & { id: string; updatedAt: Date }>,
  ): Promise<{ count: number; failed: T[] }> {
    const result = await super.updateManyWithOptimisticLock(items);
    await this.invalidateCacheMany(items.map((item) => item.id));
    return result;
  }

  /** 读取时优先走缓存 */
  override async findOne(id: string): Promise<T> {
    const cacheKey = this.getCacheKey(id);

    // 尝试从缓存读取
    const cached = await this.cache.get(cacheKey);
    if (cached) {
      this.cacheLogger.debug(`缓存命中: ${cacheKey}`);
      return cached as T;
    }

    // 缓存未命中，从数据库读取
    const entity = await super.findOne(id);

    // 写入缓存
    await this.safeCacheSet(cacheKey, entity);
    this.cacheLogger.debug(`缓存写入: ${cacheKey}, TTL=${this.ttlMs}ms`);

    return entity;
  }

  /** 更新后失效缓存 */
  override async update(id: string, data: Partial<T>): Promise<T> {
    const result = await super.update(id, data);

    // 失效缓存
    await this.invalidateCache(id);

    return result;
  }

  /** 删除后失效缓存 */
  override async delete(id: string): Promise<T> {
    const result = await super.delete(id);

    // 失效缓存
    await this.invalidateCache(id);

    return result;
  }

  /** 软删除后失效缓存 */
  override async softDelete(id: string): Promise<T> {
    const result = await super.softDelete(id);
    await this.invalidateCache(id);
    return result;
  }

  /**
   * 批量创建后失效全量缓存
   */
  override async createMany(data: Partial<T>[]): Promise<{ count: number }> {
    const result = await super.createMany(data);
    if (result.count > 0) {
      await this.invalidateAll();
    }
    return result;
  }

  /** IDs matched by a batch where (read before the write so per-ID entries can be evicted). */
  private async idsMatching(where: Record<string, unknown>): Promise<string[]> {
    const rows = (await this.db.model(this.modelName).findMany({
      where: this.scopeWhere(where),
      select: { id: true },
    })) as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  /**
   * 批量更新后失效受影响记录的单条缓存与全量缓存
   */
  override async updateMany(where: Record<string, unknown>, data: Partial<T>): Promise<{ count: number }> {
    const ids = await this.idsMatching(where);
    const result = await super.updateMany(where, data);
    if (result.count > 0) {
      await this.invalidateCacheMany(ids);
      await this.invalidateAll();
    }
    return result;
  }

  /**
   * 批量删除后失效受影响记录的单条缓存与全量缓存
   */
  override async deleteMany(where: Record<string, unknown>): Promise<{ count: number }> {
    const ids = await this.idsMatching(where);
    const result = await super.deleteMany(where);
    if (result.count > 0) {
      await this.invalidateCacheMany(ids);
      await this.invalidateAll();
    }
    return result;
  }

  /** 失效全量缓存（事务内延迟到提交后） */
  protected async invalidateAll(): Promise<void> {
    await TransactionHolder.afterCommit(async () => {
      await this.cache.del(this.getAllCacheKey());
    });
  }

  /**
   * 失效指定 ID 的缓存，并发布缓存清除事件
   *
   * 事务感知行为：
   * - 有事务上下文时：注册 afterCommit 回调，commit 后才真正失效缓存
   *   这样如果事务回滚，缓存不会被错误清除
   * - 无事务上下文时：立即执行缓存失效
   */
  protected async invalidateCache(id: string): Promise<void> {
    const doInvalidate = async () => {
      const cacheKey = this.getCacheKey(id);
      // 同时失效单条缓存和全量缓存
      await Promise.all([
        this.cache.del(cacheKey),
        this.cache.del(this.getAllCacheKey()),
      ]);
      this.cacheLogger.debug(`缓存失效: ${cacheKey} + @all`);

      // 发布缓存清除事件
      if (this.eventBus) {
        await this.eventBus.publish(
          `cache.${this.modelName}.invalidate`,
          { modelName: this.modelName, id, timestamp: Date.now() },
        );
      }
    };

    // TransactionHolder.afterCommit 会自动判断：
    // 有事务 → 注册到 afterCommit 回调
    // 无事务 → 立即执行
    await TransactionHolder.afterCommit(doInvalidate);
  }

  /**
   * 批量删除后失效缓存
   */
  override async deleteBatch(ids: string[], options?: { skipEvents?: boolean }): Promise<number> {
    const result = await super.deleteBatch(ids, options);
    // 失效每个 ID 的缓存 + 全量缓存
    await this.invalidateCacheMany(ids);
    await this.invalidateAll();
    return result;
  }

  /** 批量失效缓存 */
  protected async invalidateCacheMany(ids: string[]): Promise<void> {
    await Promise.all(ids.map((id) => this.invalidateCache(id)));
  }
}

function stableKey(value: unknown): string {
  return JSON.stringify(value, function (this: unknown, key: string, raw: unknown) {
    const current = (this as Record<string, unknown>)[key];
    if (current instanceof Date) return { $date: current.toISOString() };
    if (typeof raw === 'bigint') return { $bigint: raw.toString() };
    if (raw instanceof Map) return { $map: [...raw.entries()] };
    if (raw instanceof Set) return { $set: [...raw.values()] };
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      return Object.fromEntries(Object.keys(raw as object).sort().map((k) => [k, (raw as Record<string, unknown>)[k]]));
    }
    return raw;
  }) ?? 'undefined';
}

/**
 * @Cacheable() 方法装饰器
 * 为任意方法添加缓存能力。缓存键包含服务的模型名、方法名（或 keyPrefix）以及全部参数的
 * 类型保真哈希；null / false / 0 等结果同样会被缓存（undefined 不缓存）。
 */
export function Cacheable(options?: { ttlMs?: number; keyPrefix?: string }): MethodDecorator {
  return function (_target, propertyKey, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value;
    const prefix = options?.keyPrefix ?? String(propertyKey);
    const ttl = options?.ttlMs ?? DEFAULT_TTL_MS;

    descriptor.value = async function (this: CacheEnabledService<any>, ...args: unknown[]) {
      const scope = (this as unknown as { modelName?: string }).modelName ?? this.constructor.name;
      const argsHash = createHash('sha256').update(stableKey(args)).digest('base64url').slice(0, 32);
      const cacheKey = `${CACHE_PREFIX}${scope}:m:${prefix}:${argsHash}`;

      const cached = (await this.cache.get(cacheKey)) as { v: unknown } | undefined | null;
      if (cached && typeof cached === 'object' && 'v' in cached) {
        return cached.v;
      }

      const result = await originalMethod.apply(this, args);

      if (result !== undefined) {
        try {
          await this.cache.set(cacheKey, { v: result }, ttl);
        } catch {
          // Best-effort cache write.
        }
      }
      return result;
    };

    return descriptor;
  };
}
