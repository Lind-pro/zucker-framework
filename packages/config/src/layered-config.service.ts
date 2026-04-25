import { Injectable, Inject, Logger, Optional } from '@nestjs/common';
import { type DatabaseAdapter, ValidationException } from '@zucker/core';
import { EventEmitter2 } from 'eventemitter2';
import { ConfigScopeManager } from './config-scope-manager';

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

/** Minimal TopicEventBus interface to avoid hard dependency on @zucker/event */
interface TopicEventBusLike {
  publish(topic: string, payload: unknown): Promise<void>;
}

export interface LayeredConfigChangePayload {
  scope: string;
  key: string;
  layer: ConfigLayer;
  oldValue: unknown;
  newValue: unknown;
}

export interface LayeredConfigContext {
  tenantId?: string;
  userId?: string;
}

import { DATABASE_ADAPTER } from '@zucker/crud';

/**
 * LayeredConfigService — config with layered inheritance: system -> tenant -> user.
 *
 * Higher layers override lower layers. When getting a value, the most specific
 * layer with a value wins.
 */
@Injectable()
export class LayeredConfigService {
  private readonly logger = new Logger(LayeredConfigService.name);
  private readonly cache = new Map<string, unknown>();

  constructor(
    @Inject(DATABASE_ADAPTER) private readonly db: DatabaseAdapter,
    private readonly scopeManager: ConfigScopeManager,
    private readonly eventEmitter: EventEmitter2,
    @Optional() @Inject('TOPIC_EVENT_BUS') private readonly topicEventBus?: TopicEventBusLike,
  ) {}

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

    const compositeKey = this.buildLayerKey(scope, key, layer, ownerId);
    const oldValue = await this.getLayerValue(scope, key, layer, ownerId);

    await this.db
      .model('config')
      .update({
        where: { scope_key: { scope: compositeKey, key } },
        data: { value, updatedAt: new Date() },
      })
      .catch(async () => {
        await this.db.model('config').create({
          data: { scope: compositeKey, key, value },
        });
      });

    const payload: LayeredConfigChangePayload = {
      scope,
      key,
      layer,
      oldValue,
      newValue: value,
    };
    this.eventEmitter.emit(LAYERED_CONFIG_CHANGED_EVENT, payload);
    if (this.topicEventBus) {
      await this.topicEventBus.publish(LAYERED_CONFIG_CHANGED_TOPIC, payload);
    }
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

    const changes: LayeredConfigChangePayload[] = [];

    await this.db.$transaction(async (txDb) => {
      for (const [key, value] of entries) {
        const compositeKey = this.buildLayerKey(scope, key, layer, ownerId);
        const cacheKey = `${compositeKey}:${key}`;
        const oldValue = this.cache.get(cacheKey);

        await txDb
          .model('config')
          .update({
            where: { scope_key: { scope: compositeKey, key } },
            data: { value, updatedAt: new Date() },
          })
          .catch(async () => {
            await txDb.model('config').create({
              data: { scope: compositeKey, key, value },
            });
          });

        this.cache.set(cacheKey, value);
        changes.push({ scope, key, layer, oldValue, newValue: value });
      }
    });

    for (const payload of changes) {
      this.eventEmitter.emit(LAYERED_CONFIG_CHANGED_EVENT, payload);
    }
    if (this.topicEventBus) {
      for (const payload of changes) {
        await this.topicEventBus.publish(LAYERED_CONFIG_CHANGED_TOPIC, payload);
      }
    }
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
    const cacheKey = `${compositeKey}:${key}`;
    const oldValue = this.cache.get(cacheKey);

    await this.db.model('config').delete({
      where: { scope_key: { scope: compositeKey, key } },
    }).catch(() => {
      // Ignore if not found
    });

    this.cache.delete(cacheKey);

    const payload: LayeredConfigChangePayload = {
      scope, key, layer, oldValue, newValue: undefined,
    };
    this.eventEmitter.emit(LAYERED_CONFIG_CHANGED_EVENT, payload);
    if (this.topicEventBus) {
      await this.topicEventBus.publish(LAYERED_CONFIG_CHANGED_TOPIC, payload);
    }
  }

  /**
   * Clear the in-memory cache.
   * @param scope Optional — only clear entries for this scope prefix
   */
  clearCache(scope?: string): void {
    if (scope) {
      for (const key of this.cache.keys()) {
        if (key.startsWith(scope)) this.cache.delete(key);
      }
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
    const cacheKey = `${compositeKey}:${key}`;

    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey);
    }

    const record = await this.db.model('config').findUnique({
      where: { scope_key: { scope: compositeKey, key } },
    }) as { key: string; value: unknown } | null;

    if (record) {
      this.cache.set(cacheKey, record.value);
    }

    return record?.value;
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
      result[record.key] = record.value;
    }
    return result;
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
