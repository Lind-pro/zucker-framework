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

/**
 * 全量缓存键
 * 用于缓存整个表的数据（适用于数据量较小的配置表等）
 */
const ALL_DATA_KEY = '@all';

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
    return `${CACHE_PREFIX}${this.modelName}:${id}`;
  }

  /** 全量缓存键 */
  protected getAllCacheKey(): string {
    return `${CACHE_PREFIX}${this.modelName}:${ALL_DATA_KEY}`;
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
    await this.cache.set(cacheKey, all, this.ttlMs);
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
    // 失效全量缓存
    await this.cache.del(this.getAllCacheKey());
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
    await this.cache.set(cacheKey, entity, this.ttlMs);
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
      await this.cache.del(this.getAllCacheKey());
    }
    return result;
  }

  /**
   * 批量更新后失效全量缓存
   */
  override async updateMany(where: Record<string, unknown>, data: Partial<T>): Promise<{ count: number }> {
    const result = await super.updateMany(where, data);
    if (result.count > 0) {
      await this.cache.del(this.getAllCacheKey());
    }
    return result;
  }

  /**
   * 批量删除后失效全量缓存
   */
  override async deleteMany(where: Record<string, unknown>): Promise<{ count: number }> {
    const result = await super.deleteMany(where);
    if (result.count > 0) {
      await this.cache.del(this.getAllCacheKey());
    }
    return result;
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
    await Promise.all([
      ...ids.map((id) => this.cache.del(this.getCacheKey(id))),
      this.cache.del(this.getAllCacheKey()),
    ]);
    return result;
  }

  /** 批量失效缓存 */
  protected async invalidateCacheMany(ids: string[]): Promise<void> {
    await Promise.all(ids.map((id) => this.invalidateCache(id)));
  }
}

/**
 * @Cacheable() 方法装饰器
 * 为任意方法添加缓存能力，使用方法的第一个参数作为缓存键的一部分
 */
export function Cacheable(options?: { ttlMs?: number; keyPrefix?: string }): MethodDecorator {
  return function (_target, propertyKey, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value;
    const prefix = options?.keyPrefix ?? String(propertyKey);
    const ttl = options?.ttlMs ?? DEFAULT_TTL_MS;

    descriptor.value = async function (this: CacheEnabledService<any>, ...args: unknown[]) {
      const keyPart = args.length > 0 ? String(args[0]) : 'default';
      const cacheKey = `${CACHE_PREFIX}${prefix}:${keyPart}`;

      const cached = await this.cache.get(cacheKey);
      if (cached) {
        return cached;
      }

      const result = await originalMethod.apply(this, args);

      await this.cache.set(cacheKey, result, ttl);
      return result;
    };

    return descriptor;
  };
}
