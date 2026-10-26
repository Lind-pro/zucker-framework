import { Injectable, Inject, Logger, Optional } from '@nestjs/common';
import { type DatabaseAdapter, ValidationException } from '@zucker-framework/core';
// The CommonJS default is the original EventEmitter2 constructor in both formats.
import EventEmitter2Constructor, { type EventEmitter2 } from 'eventemitter2';
import { ConfigScopeManager } from './config-scope-manager';

/** Internal model for a config record row */
interface ConfigRecord {
  scope: string;
  key: string;
  value: unknown;
}

import { DATABASE_ADAPTER } from '@zucker-framework/crud';
export { DATABASE_ADAPTER };
export const CONFIG_CHANGED_EVENT = 'zucker.config-changed';

/**
 * TopicEventBus topic for config changes.
 * Uses `/` delimiter to match DefaultTopicEventBus conventions.
 * Subscribers can use wildcards: `system/config/**`
 */
export const CONFIG_CHANGED_TOPIC = 'system/config/changed';

/** Optional encryption adapter for encrypting/decrypting sensitive config values */
export const CONFIG_ENCRYPTOR = 'CONFIG_ENCRYPTOR';

export interface ConfigChangePayload {
  scope: string;
  key: string;
  oldValue: unknown;
  newValue: unknown;
}

/**
 * Encryption adapter interface for config values.
 *
 * Reference: jetlinks stores some config values encrypted;
 * this provides a pluggable encryption mechanism.
 */
export interface ConfigEncryptor {
  encrypt(value: string): string | Promise<string>;
  decrypt(value: string): string | Promise<string>;
}

/** Minimal TopicEventBus interface to avoid hard dependency on @zucker-framework/event */
interface TopicEventBusLike {
  publish(topic: string, payload: unknown): Promise<void>;
}

@Injectable()
export class ConfigService {
  private readonly logger = new Logger(ConfigService.name);
  private readonly cache = new Map<string, unknown>();
  private static readonly CACHE_MAX_SIZE = 1024;

  constructor(
    @Inject(DATABASE_ADAPTER) private readonly db: DatabaseAdapter,
    @Optional() @Inject(EventEmitter2Constructor) private readonly eventEmitter?: EventEmitter2,
    @Optional() private readonly scopeManager?: ConfigScopeManager,
    @Optional() @Inject(CONFIG_ENCRYPTOR) private readonly encryptor?: ConfigEncryptor,
    @Optional() @Inject('TOPIC_EVENT_BUS') private readonly topicEventBus?: TopicEventBusLike,
  ) {}

  /**
   * 获取指定 scope 和 key 的配置值
   * @param scope 配置域
   * @param key 配置键
   * @returns 配置值，不存在时返回 undefined
   */
  async get<T = string>(scope: string, key: string): Promise<T | undefined> {
    const cacheKey = `${scope}:${key}`;
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey) as T;
    }

    const record = await this.db.model('config').findUnique({
      where: { scope_key: { scope, key } },
    }) as ConfigRecord | null;

    if (!record) return undefined;

    let value = record.value as T;

    // Decrypt if this property is marked as encrypted
    if (this.encryptor && this.isEncryptedProperty(scope, key)) {
      try {
        value = (await this.encryptor.decrypt(value as unknown as string)) as unknown as T;
      } catch (decryptError) {
        this.logger.error(`Failed to decrypt config ${scope}.${key}: ${decryptError instanceof Error ? decryptError.message : String(decryptError)}`);
        return undefined;
      }
    }

    while (this.cache.size >= ConfigService.CACHE_MAX_SIZE) {
      const firstKey = this.cache.keys().next().value!;
      this.cache.delete(firstKey);
    }
    this.cache.set(cacheKey, value);
    return value;
  }

  /**
   * Get a config value with a fallback default.
   * If no stored value exists, checks the scope definition default,
   * then falls back to the provided default.
   *
   * Reference: jetlinks getProperties merges defaults from ConfigPropertyDef.
   */
  async getOrDefault<T = string>(scope: string, key: string, defaultValue: T): Promise<T> {
    const value = await this.get<T>(scope, key);
    if (value !== undefined) return value;

    // Check scope definition default
    if (this.scopeManager?.has(scope)) {
      const prop = this.scopeManager.getProperties(scope).find((p) => p.key === key);
      if (prop?.defaultValue !== undefined) return prop.defaultValue as T;
    }

    return defaultValue;
  }

  /**
   * 设置配置值（自动触发变更事件）
   * @param scope 配置域
   * @param key 配置键
   * @param value 配置值
   * @throws ValidationException 校验失败时
   */
  async set(scope: string, key: string, value: unknown): Promise<void> {
    // Validate against scope definition if available
    if (this.scopeManager?.has(scope)) {
      const errors = this.scopeManager.validate(scope, key, value);
      if (errors.length > 0) {
        throw new ValidationException(
          { [key]: errors },
          `Config validation failed: ${errors.join(', ')}`,
        );
      }
    }

    const cacheKey = `${scope}:${key}`;

    // Load oldValue from cache or DB (cold-cache safe)
    let oldValue = this.cache.get(cacheKey);
    if (oldValue === undefined) {
      const existing = await this.db.model('config').findUnique({
        where: { scope_key: { scope, key } },
      }) as ConfigRecord | null;
      if (existing) {
        oldValue = existing.value;
      }
    }

    // Encrypt if needed
    let storedValue = value;
    if (this.encryptor && this.isEncryptedProperty(scope, key) && typeof value === 'string') {
      storedValue = await this.encryptor.encrypt(value);
    }

    await this.db.model('config').update({
      where: { scope_key: { scope, key } },
      data: { value: storedValue },
    }).catch(async (updateError: unknown) => {
      // upsert: create if not exists
      this.logger.debug(`Config key ${scope}.${key} not found, creating: ${updateError instanceof Error ? updateError.message : String(updateError)}`);
      await this.db.model('config').create({
        data: { scope, key, value: storedValue },
      });
    });

    while (this.cache.size >= ConfigService.CACHE_MAX_SIZE) {
      const firstKey = this.cache.keys().next().value!;
      this.cache.delete(firstKey);
    }
    this.cache.set(cacheKey, value);

    // 记录配置变更历史（支持版本回溯）
    await this.recordHistory(scope, key, oldValue, value);

    const payload: ConfigChangePayload = { scope, key, oldValue, newValue: value };
    this.eventEmitter?.emit(CONFIG_CHANGED_EVENT, payload);
    // Publish to TopicEventBus for cross-module event-driven integration
    if (this.topicEventBus) {
      await this.topicEventBus.publish(CONFIG_CHANGED_TOPIC, payload);
    }
    this.logger.debug(`Config updated: ${scope}.${key}`);
  }

  /**
   * Set multiple properties at once for a scope.
   * Performs batch validation first, then persists all values and emits
   * a single consolidated event — mirrors jetlinks ConfigManager.setProperties(scope, Map)
   * which does repository.save + cache.evict instead of N individual updates.
   */
  async setProperties(scope: string, values: Record<string, unknown>): Promise<void> {
    const entries = Object.entries(values);
    if (entries.length === 0) return;

    // Batch validate all entries first (fail-fast)
    if (this.scopeManager?.has(scope)) {
      const allErrors: Record<string, string[]> = {};
      for (const [key, value] of entries) {
        const errors = this.scopeManager.validate(scope, key, value);
        if (errors.length > 0) {
          allErrors[key] = errors;
        }
      }
      if (Object.keys(allErrors).length > 0) {
        throw new ValidationException(
          allErrors,
          `Config batch validation failed`,
        );
      }
    }

    // Collect old values for change payloads
    const changes: ConfigChangePayload[] = [];

    await this.db.$transaction(async (tx: DatabaseAdapter) => {
      for (const [key, value] of entries) {
        const cacheKey = `${scope}:${key}`;
        const oldValue = this.cache.get(cacheKey);

        // Encrypt if needed
        let storedValue = value;
        if (this.encryptor && this.isEncryptedProperty(scope, key) && typeof value === 'string') {
          storedValue = await this.encryptor.encrypt(value);
        }

        await tx.model('config').update({
          where: { scope_key: { scope, key } },
          data: { value: storedValue },
        }).catch(async (updateError: unknown) => {
          this.logger.debug(`Config key ${scope}.${key} not found, creating: ${updateError instanceof Error ? updateError.message : String(updateError)}`);
          await tx.model('config').create({
            data: { scope, key, value: storedValue },
          });
        });

        if (this.cache.size >= ConfigService.CACHE_MAX_SIZE) {
          const firstKey = this.cache.keys().next().value!;
          this.cache.delete(firstKey);
        }
        this.cache.set(cacheKey, value);
        changes.push({ scope, key, oldValue, newValue: value });
      }
    });

    // Emit events after all writes succeed (single batch notification)
    for (const payload of changes) {
      this.eventEmitter?.emit(CONFIG_CHANGED_EVENT, payload);
    }
    if (this.topicEventBus) {
      for (const payload of changes) {
        await this.topicEventBus.publish(CONFIG_CHANGED_TOPIC, payload);
      }
    }
    this.logger.debug(`Config batch updated: ${scope} (${entries.length} properties)`);
  }

  /**
   * 获取指定 scope 下的所有配置
   * @param scope 配置域
   * @returns 键值对集合（包含默认值）
   */
  async getAll(scope: string): Promise<Record<string, unknown>> {
    const records = await this.db.model('config').findMany({
      where: { scope },
    }) as ConfigRecord[];

    const result: Record<string, unknown> = {};

    // Start with defaults from scope definition
    if (this.scopeManager?.has(scope)) {
      const props = this.scopeManager.getProperties(scope);
      for (const prop of props) {
        if (prop.defaultValue !== undefined) {
          result[prop.key] = prop.defaultValue;
        }
      }
    }

    // Override with stored values
    for (const record of records) {
      let value = record.value;

      // Decrypt if encrypted property
      if (this.encryptor && this.isEncryptedProperty(scope, record.key)) {
        try {
          value = await this.encryptor.decrypt(value as string);
        } catch (decryptError) {
          this.logger.error(`Failed to decrypt config ${scope}.${record.key}: ${decryptError instanceof Error ? decryptError.message : String(decryptError)}`);
          continue;
        }
      }

      result[record.key] = value;
      if (this.cache.size >= ConfigService.CACHE_MAX_SIZE) {
        const firstKey = this.cache.keys().next().value!;
        this.cache.delete(firstKey);
      }
      this.cache.set(`${scope}:${record.key}`, value);
    }

    return result;
  }

  /**
   * Remove a specific config property.
   */
  async remove(scope: string, key: string): Promise<void> {
    const cacheKey = `${scope}:${key}`;

    // Load oldValue from cache or DB (cold-cache safe)
    let oldValue = this.cache.get(cacheKey);
    if (oldValue === undefined) {
      const existing = await this.db.model('config').findUnique({
        where: { scope_key: { scope, key } },
      }) as ConfigRecord | null;
      if (existing) {
        oldValue = existing.value;
      }
    }

    await this.db.model('config').delete({
      where: { scope_key: { scope, key } },
    }).catch(() => {
      // Ignore if not found
    });

    this.cache.delete(cacheKey);

    const payload: ConfigChangePayload = { scope, key, oldValue, newValue: undefined };
    this.eventEmitter?.emit(CONFIG_CHANGED_EVENT, payload);
    if (this.topicEventBus) {
      await this.topicEventBus.publish(CONFIG_CHANGED_TOPIC, payload);
    }
  }

  /**
   * 监听配置变更事件
   * @param callback 变更回调
   * @returns 订阅句柄，调用 unsubscribe() 取消监听
   */
  onChange(callback: (payload: ConfigChangePayload) => void): { unsubscribe: () => void } {
    // eventEmitter 缺失时（host app 未注册 EventEmitterModule）退化为 no-op 订阅。
    if (!this.eventEmitter) return { unsubscribe: () => undefined };
    const ee = this.eventEmitter;
    ee.on(CONFIG_CHANGED_EVENT, callback);
    return {
      unsubscribe: () => ee.off(CONFIG_CHANGED_EVENT, callback),
    };
  }

  /**
   * 监听指定 scope.key 的配置变更，每次变更时执行回调。
   *
   * @param scope 配置域
   * @param key 配置键（可选，不传则监听整个 scope）
   * @param callback 变更回调
   * @returns 取消监听函数
   */
  watch<T = unknown>(
    scope: string,
    key: string | undefined,
    callback: (newValue: T, oldValue: T | undefined) => void,
  ): { unsubscribe: () => void } {
    const handler = (payload: ConfigChangePayload) => {
      if (payload.scope !== scope) return;
      if (key && payload.key !== key) return;
      callback(payload.newValue as T, payload.oldValue as T | undefined);
    };
    if (!this.eventEmitter) return { unsubscribe: () => undefined };
    const ee = this.eventEmitter;
    ee.on(CONFIG_CHANGED_EVENT, handler);
    return {
      unsubscribe: () => ee.off(CONFIG_CHANGED_EVENT, handler),
    };
  }

  /**
   * 清除配置缓存
   * @param scope 可选的配置域，不传则清除所有缓存
   */
  clearCache(scope?: string): void {
    if (scope) {
      const prefix = `${scope}:`;
      for (const key of this.cache.keys()) {
        if (key.startsWith(prefix)) this.cache.delete(key);
      }
    } else {
      this.cache.clear();
    }
  }

  // ─── 配置版本控制 ──────────────────────────────────────────────────

  /**
   * 记录配置变更历史（自动版本号递增）
   * 配置版本控制
   */
  private async recordHistory(
    scope: string,
    key: string,
    oldValue: unknown,
    newValue: unknown,
  ): Promise<void> {
    try {
      await this.db.model('configHistory').create({
        data: {
          scope,
          key,
          oldValue: oldValue !== undefined ? JSON.stringify(oldValue) : null,
          newValue: JSON.stringify(newValue),
          changedAt: new Date(),
        },
      });
    } catch {
      // configHistory model may not exist — gracefully skip
    }
  }

  /**
   * 查询配置变更历史
   * @param scope 配置域
   * @param key 配置键（可选，不传则查询该 scope 所有变更）
   * @param limit 返回条数（默认 20）
   */
  async getHistory(
    scope: string,
    key?: string,
    limit = 20,
  ): Promise<Array<{ scope: string; key: string; oldValue: unknown; newValue: unknown; changedAt: Date }>> {
    try {
      const where: Record<string, unknown> = { scope };
      if (key) where.key = key;

      return await this.db.model('configHistory').findMany({
        where,
        orderBy: { changedAt: 'desc' },
        take: limit,
      }) as Array<{ scope: string; key: string; oldValue: unknown; newValue: unknown; changedAt: Date }>;
    } catch {
      return [];
    }
  }

  /**
   * 回滚配置到指定历史版本
   * @param historyId 历史记录 ID
   */
  async rollback(historyId: string): Promise<void> {
    try {
      const record = await this.db.model('configHistory').findUnique({
        where: { id: historyId },
      }) as { scope: string; key: string; oldValue: string | null } | null;

      if (!record || record.oldValue === null) return;

      const value = JSON.parse(record.oldValue);
      await this.set(record.scope, record.key, value);
    } catch (error) {
      this.logger.warn(`Config rollback failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Check if a property is marked as encrypted in its scope definition.
   */
  private isEncryptedProperty(scope: string, key: string): boolean {
    if (!this.scopeManager) return false;
    const props = this.scopeManager.getProperties(scope);
    const prop = props.find((p) => p.key === key);
    return prop?.encrypted === true;
  }
}
