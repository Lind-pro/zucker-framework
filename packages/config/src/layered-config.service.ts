import { Injectable, Inject, Logger, Optional, type OnModuleDestroy } from '@nestjs/common';
import { type DatabaseAdapter, ValidationException } from '@zucker-framework/core';
// The CommonJS default is the original EventEmitter2 constructor in both formats.
import EventEmitter2Constructor, { type EventEmitter2 } from 'eventemitter2';
import { ConfigScopeManager } from './config-scope-manager';
import { CONFIG_ENCRYPTOR, type ConfigEncryptor } from './config.service';
import {
  BoundedTtlCache,
  CONFIG_CACHE_OPTIONS,
  configCacheKey,
  isRecordNotFound,
  unsubscribeQuietly,
  type ConfigCacheOptions,
  type TopicEventBusLike,
} from './config-cache';

export type ConfigLayer = 'system' | 'tenant' | 'user';

export const CONFIG_LAYER_PRIORITY: Record<ConfigLayer, number> = {
  system: 0,
  tenant: 1,
  user: 2,
};

export const LAYERED_CONFIG_CHANGED_EVENT = 'zucker.layered-config-changed';

/**
 * TopicEventBus topic for layered config changes.
 * Uses `/` delimiter to match DefaultTopicEventBus conventions.
 */
export const LAYERED_CONFIG_CHANGED_TOPIC = 'system/config/layered-changed';

export interface LayeredConfigChangePayload {
  scope: string;
  key: string;
  layer: ConfigLayer;
  oldValue: unknown;
  newValue: unknown;
  /** Tenant or user id for tenant/user layers. */
  ownerId?: string;
  /** Protected (encrypted) values are redacted in events. */
  sensitive?: true;
}

const PROTECTED_CONFIG_VALUE = '[REDACTED]';

export interface LayeredConfigContext {
  tenantId?: string;
  userId?: string;
}

import { DATABASE_ADAPTER } from '@zucker-framework/crud';

/**
 * LayeredConfigService — config with layered inheritance: system -> tenant -> user.
 *
 * Higher layers override lower layers. When getting a value, the most specific
 * layer with a value wins.
 */
@Injectable()
export class LayeredConfigService implements OnModuleDestroy {
  private readonly logger = new Logger(LayeredConfigService.name);
  /** Bounded (default 1024 entries) and TTL-limited (default 60 s); holds decrypted values. */
  private readonly cache: BoundedTtlCache;
  private readonly busSubscription: unknown;

  constructor(
    @Inject(DATABASE_ADAPTER) private readonly db: DatabaseAdapter,
    private readonly scopeManager: ConfigScopeManager,
    @Optional() @Inject(EventEmitter2Constructor) private readonly eventEmitter?: EventEmitter2,
    @Optional() @Inject('TOPIC_EVENT_BUS') private readonly topicEventBus?: TopicEventBusLike,
    @Optional() @Inject(CONFIG_ENCRYPTOR) private readonly encryptor?: ConfigEncryptor | null,
    @Optional() @Inject(CONFIG_CACHE_OPTIONS) cacheOptions?: ConfigCacheOptions,
  ) {
    this.cache = new BoundedTtlCache(cacheOptions ?? {});
    this.busSubscription = typeof topicEventBus?.subscribe === 'function'
      ? topicEventBus.subscribe(LAYERED_CONFIG_CHANGED_TOPIC, (message) => {
          const change = message?.payload as Partial<LayeredConfigChangePayload> | undefined;
          if (typeof change?.scope !== 'string' || typeof change.key !== 'string') return;
          const { scope, key } = change;
          if (change.layer && (change.layer === 'system' || typeof change.ownerId === 'string')) {
            this.cache.delete(this.cacheKey(scope, key, change.layer, change.ownerId));
          } else {
            // Older publishers omit ownerId: drop every layer of this scope/key.
            this.cache.deleteWhere((k) => k.startsWith(configCacheKey(scope, '')) && k.endsWith(configCacheKey('', key)));
          }
        })
      : undefined;
  }

  onModuleDestroy(): void {
    unsubscribeQuietly(this.busSubscription);
  }

  /**
   * Get a config value, resolving through layers (user > tenant > system > default).
   */
  async get<T = unknown>(
    scope: string,
    key: string,
    context?: LayeredConfigContext,
  ): Promise<T | undefined> {
    // Check user layer first (highest priority)
    if (context?.userId) {
      const userValue = await this.getLayerValue(scope, key, 'user', context.userId);
      if (userValue !== undefined) return userValue as T;
    }

    // Then tenant layer
    if (context?.tenantId) {
      const tenantValue = await this.getLayerValue(scope, key, 'tenant', context.tenantId);
      if (tenantValue !== undefined) return tenantValue as T;
    }

    // Then system layer
    const systemValue = await this.getLayerValue(scope, key, 'system');
    if (systemValue !== undefined) return systemValue as T;

    // Fall back to scope default
    const scopeDef = this.scopeManager.get(scope);
    if (scopeDef) {
      const prop = scopeDef.properties.find((p) => p.key === key);
      if (prop) return prop.defaultValue as T;
    }

    return undefined;
  }

  /**
   * Set a config value at a specific layer.
   */
  async set(
    scope: string,
    key: string,
    value: unknown,
    layer: ConfigLayer,
    ownerId?: string,
  ): Promise<void> {
    // Validate against scope definition
    const errors = this.scopeManager.validate(scope, key, value);
    if (errors.length > 0) {
      throw new ValidationException(
        { [key]: errors },
        `Config validation failed: ${errors.join(', ')}`,
      );
    }

    this.requireEncryption(scope, key, value);
    const compositeKey = this.buildLayerKey(scope, key, layer, ownerId);
    const oldValue = await this.getLayerValue(scope, key, layer, ownerId);
    const storedValue = await this.encryptIfNeeded(scope, key, value);

    await this.db
      .model('config')
      .update({
        where: { scope_key: { scope: compositeKey, key } },
        data: { value: storedValue, updatedAt: new Date() },
      })
      .catch(async (error: unknown) => {
        if (!isRecordNotFound(error)) throw error;
        await this.db.model('config').create({
          data: { scope: compositeKey, key, value: storedValue },
        });
      });
    // Serve the new value immediately (previously the stale pre-write value stayed cached).
    this.cache.set(this.cacheKey(scope, key, layer, ownerId), value);

    await this.publishChange(this.changePayload(scope, key, layer, ownerId, oldValue, value));
  }

  /**
   * Get all values for a scope, merged across layers.
   */
  async getAll(
    scope: string,
    context?: LayeredConfigContext,
  ): Promise<Record<string, unknown>> {
    const result: Record<string, unknown> = {};

    // Start with defaults
    const scopeDef = this.scopeManager.get(scope);
    if (scopeDef) {
      for (const prop of scopeDef.properties) {
        if (prop.defaultValue !== undefined) {
          result[prop.key] = prop.defaultValue;
        }
      }
    }

    // System layer
    const systemRecords = await this.getLayerRecords(scope, 'system');
    for (const [k, v] of Object.entries(systemRecords)) {
      result[k] = v;
    }

    // Tenant layer
    if (context?.tenantId) {
      const tenantRecords = await this.getLayerRecords(scope, 'tenant', context.tenantId);
      for (const [k, v] of Object.entries(tenantRecords)) {
        result[k] = v;
      }
    }

    // User layer
    if (context?.userId) {
      const userRecords = await this.getLayerRecords(scope, 'user', context.userId);
      for (const [k, v] of Object.entries(userRecords)) {
        result[k] = v;
      }
    }

    return result;
  }

  /**
   * Set multiple properties at a specific layer.
   * Validates all entries first, then persists in batch.
   *
   * Reference: jetlinks ConfigManager.setProperties(scope, Map)
   */
  async setProperties(
    scope: string,
    values: Record<string, unknown>,
    layer: ConfigLayer,
    ownerId?: string,
  ): Promise<void> {
    const entries = Object.entries(values);
    if (entries.length === 0) return;

    // Batch validation
    const allErrors: Record<string, string[]> = {};
    for (const [key, value] of entries) {
      const errors = this.scopeManager.validate(scope, key, value);
      if (errors.length > 0) {
        allErrors[key] = errors;
      }
    }
    if (Object.keys(allErrors).length > 0) {
      throw new ValidationException(allErrors, `Layered config batch validation failed`);
    }
    for (const [key, value] of entries) this.requireEncryption(scope, key, value);

    const changes: LayeredConfigChangePayload[] = [];

    await this.db.$transaction(async (txDb) => {
      for (const [key, value] of entries) {
        const compositeKey = this.buildLayerKey(scope, key, layer, ownerId);
        const oldValue = this.cache.get(this.cacheKey(scope, key, layer, ownerId));
        const storedValue = await this.encryptIfNeeded(scope, key, value);

        await txDb
          .model('config')
          .update({
            where: { scope_key: { scope: compositeKey, key } },
            data: { value: storedValue, updatedAt: new Date() },
          })
          .catch(async (error: unknown) => {
            if (!isRecordNotFound(error)) throw error;
            await txDb.model('config').create({
              data: { scope: compositeKey, key, value: storedValue },
            });
          });

        changes.push(this.changePayload(scope, key, layer, ownerId, oldValue, value));
      }
    });

    // Only after commit: a rolled-back transaction must not leave memory ahead of storage.
    for (const [key, value] of entries) {
      this.cache.set(this.cacheKey(scope, key, layer, ownerId), value);
    }
    for (const payload of changes) await this.publishChange(payload);
  }

  /**
   * Remove a config value at a specific layer.
   */
  async remove(
    scope: string,
    key: string,
    layer: ConfigLayer,
    ownerId?: string,
  ): Promise<void> {
    const compositeKey = this.buildLayerKey(scope, key, layer, ownerId);
    const cacheKey = this.cacheKey(scope, key, layer, ownerId);
    const oldValue = this.cache.get(cacheKey);

    await this.db.model('config').delete({
      where: { scope_key: { scope: compositeKey, key } },
    }).catch(() => {
      // Ignore if not found
    });

    this.cache.delete(cacheKey);

    await this.publishChange(this.changePayload(scope, key, layer, ownerId, oldValue, undefined));
  }

  /**
   * Clear the in-memory cache.
   * @param scope Optional — only clear entries for this scope prefix
   */
  clearCache(scope?: string): void {
    if (scope) {
      const prefix = configCacheKey(scope, '');
      this.cache.deleteWhere((key) => key.startsWith(prefix));
    } else {
      this.cache.clear();
    }
  }

  private async getLayerValue(
    scope: string,
    key: string,
    layer: ConfigLayer,
    ownerId?: string,
  ): Promise<unknown | undefined> {
    const compositeKey = this.buildLayerKey(scope, key, layer, ownerId);
    const cacheKey = this.cacheKey(scope, key, layer, ownerId);

    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey);
    }

    const record = await this.db.model('config').findUnique({
      where: { scope_key: { scope: compositeKey, key } },
    }) as { key: string; value: unknown } | null;

    if (!record) return undefined;
    const value = await this.decryptIfNeeded(scope, key, record.value);
    this.cache.set(cacheKey, value);
    return value;
  }

  private async getLayerRecords(
    scope: string,
    layer: ConfigLayer,
    ownerId?: string,
  ): Promise<Record<string, unknown>> {
    const compositeScope = ownerId ? `${scope}@${layer}:${ownerId}` : `${scope}@${layer}`;
    const records = await this.db.model('config').findMany({
      where: { scope: compositeScope },
    }) as Array<{ key: string; value: unknown }>;
    const result: Record<string, unknown> = {};
    for (const record of records) {
      result[record.key] = await this.decryptIfNeeded(scope, record.key, record.value);
    }
    return result;
  }

  private cacheKey(scope: string, key: string, layer: ConfigLayer, ownerId?: string): string {
    return configCacheKey(scope, layer, ownerId ?? '', key);
  }

  private async publishChange(payload: LayeredConfigChangePayload): Promise<void> {
    this.eventEmitter?.emit(LAYERED_CONFIG_CHANGED_EVENT, payload);
    if (this.topicEventBus) {
      await this.topicEventBus.publish(LAYERED_CONFIG_CHANGED_TOPIC, payload);
    }
  }

  private isEncryptedProperty(scope: string, key: string): boolean {
    return this.scopeManager.getProperties(scope).find((p) => p.key === key)?.encrypted === true;
  }

  private requireEncryption(scope: string, key: string, value: unknown): void {
    if (!this.isEncryptedProperty(scope, key)) return;
    if (!this.encryptor) throw new Error('Protected configuration requires an encryption adapter');
    if (typeof value !== 'string') throw new Error('Protected configuration must be a string');
  }

  private async encryptIfNeeded(scope: string, key: string, value: unknown): Promise<unknown> {
    if (!this.isEncryptedProperty(scope, key)) return value;
    return this.encryptor!.encrypt(value as string);
  }

  private async decryptIfNeeded(scope: string, key: string, value: unknown): Promise<unknown> {
    if (!this.isEncryptedProperty(scope, key)) return value;
    if (!this.encryptor) throw new Error('Protected configuration requires an encryption adapter');
    try {
      return await this.encryptor.decrypt(value as string);
    } catch {
      this.logger.error(`Failed to decrypt protected layered config ${scope}.${key}`);
      throw new Error('Protected configuration could not be decrypted');
    }
  }

  private changePayload(
    scope: string, key: string, layer: ConfigLayer, ownerId: string | undefined,
    oldValue: unknown, newValue: unknown,
  ): LayeredConfigChangePayload {
    const base = { scope, key, layer, ...(ownerId !== undefined ? { ownerId } : {}) };
    if (!this.isEncryptedProperty(scope, key)) return { ...base, oldValue, newValue };
    return {
      ...base,
      oldValue: oldValue === undefined ? undefined : PROTECTED_CONFIG_VALUE,
      newValue: newValue === undefined ? undefined : PROTECTED_CONFIG_VALUE,
      sensitive: true,
    };
  }

  private buildLayerKey(
    scope: string,
    _key: string,
    layer: ConfigLayer,
    ownerId?: string,
  ): string {
    if (ownerId) {
      return `${scope}@${layer}:${ownerId}`;
    }
    return `${scope}@${layer}`;
  }
}
