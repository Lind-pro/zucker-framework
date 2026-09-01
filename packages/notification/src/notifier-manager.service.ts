import { Injectable, Logger, Inject, Optional, OnModuleDestroy } from '@nestjs/common';
import { NotFoundException, BusinessException } from '@zucker/core';
import type { TopicEventBus } from '@zucker/event';
import type {
  Notifier,
  NotifierProvider,
  NotifierConfig,
  NotifyChannel,
  NotifyType,
} from './notifier.interface';
import { NotifierEventDispatcher, NotifierEventTopics } from './notifier-event-dispatcher';
import { NOTIFIER_PROVIDER_REGISTRY, NOTIFY_CONFIG_MANAGER, TOPIC_EVENT_BUS_TOKEN } from './notification.tokens';

/**
 * Notifier config manager — mirrors jetlinks NotifyConfigManager.
 *
 * Provides configuration persistence for notifier instances.
 * Applications should implement this interface to store/retrieve
 * notifier configurations from their database.
 */
export interface NotifyConfigManager {
  getNotifyConfig(channel: NotifyChannel, configId: string): Promise<NotifierConfig | null>;
  saveNotifyConfig(config: NotifierConfig): Promise<void>;
  removeNotifyConfig(configId: string): Promise<void>;
  listConfigs(channel?: NotifyChannel): Promise<NotifierConfig[]>;
}

export { NOTIFY_CONFIG_MANAGER } from './notification.tokens';

/**
 * Composite config manager — mirrors jetlinks CompositeNotifyConfigManager.
 *
 * Chains multiple NotifyConfigManager implementations, trying each in order
 * until a config is found. This allows layering static config-file-based
 * configs with database-backed configs.
 */
export class CompositeNotifyConfigManager implements NotifyConfigManager {
  constructor(private readonly managers: NotifyConfigManager[]) {}

  async getNotifyConfig(channel: NotifyChannel, configId: string): Promise<NotifierConfig | null> {
    for (const manager of this.managers) {
      const config = await manager.getNotifyConfig(channel, configId);
      if (config) return config;
    }
    return null;
  }

  async saveNotifyConfig(config: NotifierConfig): Promise<void> {
    // Delegate to the first manager (primary)
    if (this.managers.length > 0) {
      await this.managers[0].saveNotifyConfig(config);
    }
  }

  async removeNotifyConfig(configId: string): Promise<void> {
    if (this.managers.length > 0) {
      await this.managers[0].removeNotifyConfig(configId);
    }
  }

  async listConfigs(channel?: NotifyChannel): Promise<NotifierConfig[]> {
    const allConfigs: NotifierConfig[] = [];
    const seenIds = new Set<string>();
    for (const manager of this.managers) {
      const configs = await manager.listConfigs(channel);
      for (const config of configs) {
        if (!seenIds.has(config.id)) {
          seenIds.add(config.id);
          allConfigs.push(config);
        }
      }
    }
    return allConfigs;
  }
}

/**
 * Notifier manager — mirrors jetlinks NotifierManager.
 *
 * Manages the lifecycle of Notifier instances: creation, caching,
 * and cleanup. Uses NotifierProvider factories to create notifiers
 * from configuration, and caches active instances for reuse.
 */
@Injectable()
export class NotifierManagerService implements OnModuleDestroy {
  private readonly logger = new Logger(NotifierManagerService.name);
  private readonly notifiers = new Map<string, Notifier>();

  constructor(
    @Inject(NOTIFIER_PROVIDER_REGISTRY)
    private readonly providerRegistry: NotifierProvider[],
    @Optional()
    @Inject(NOTIFY_CONFIG_MANAGER)
    private readonly configManager?: NotifyConfigManager,
    @Optional()
    @Inject(TOPIC_EVENT_BUS_TOKEN)
    private readonly eventBus?: TopicEventBus,
  ) {}

  /**
   * Get or create a notifier by channel and config ID.
   * Mirrors jetlinks NotifierManager.getNotifier().
   */
  async getNotifier(channel: NotifyChannel, configId: string): Promise<Notifier> {
    const cacheKey = `${channel}:${configId}`;

    // Return cached instance if available
    const cached = this.notifiers.get(cacheKey);
    if (cached) {
      return cached;
    }

    // Lookup config
    if (!this.configManager) {
      throw new BusinessException('NotifyConfigManager not configured. Provide NOTIFY_CONFIG_MANAGER.', 'NOTIFIER_NOT_CONFIGURED', 500);
    }

    const config = await this.configManager.getNotifyConfig(channel, configId);
    if (!config) {
      throw new NotFoundException(`Notifier config not found: channel=${channel}, id=${configId}`);
    }

    return this.createNotifier(config);
  }

  /**
   * Get a notifier by NotifyType and config ID.
   * Mirrors jetlinks NotifierManager.getNotifier(NotifyType, String) — accepts
   * the extensible NotifyType interface instead of only the NotifyChannel enum.
   */
  async getNotifierByType(type: NotifyType, configId: string): Promise<Notifier> {
    // Map NotifyType.getId() to NotifyChannel by matching against known channels
    const typeId = type.getId().toUpperCase();
    const channelMap: Record<string, NotifyChannel> = {
      SMS: 'SMS' as NotifyChannel,
      EMAIL: 'EMAIL' as NotifyChannel,
      VOICE: 'VOICE' as NotifyChannel,
      DINGTALK: 'DINGTALK' as NotifyChannel,
      WEIXIN: 'WECHAT' as NotifyChannel,
      WECHAT: 'WECHAT' as NotifyChannel,
      WEBHOOK: 'WEBHOOK' as NotifyChannel,
    };
    const channel = channelMap[typeId];
    if (!channel) {
      throw new BusinessException(
        `Unsupported notify type: ${type.getId()}`,
        'UNSUPPORTED_NOTIFY_TYPE',
        400,
      );
    }
    return this.getNotifier(channel, configId);
  }

  /**
   * Create a notifier from properties.
   * Mirrors jetlinks NotifierManager.createNotifier().
   */
  async createNotifier(config: NotifierConfig): Promise<Notifier> {
    const cacheKey = `${config.channel}:${config.id}`;

    // Close existing notifier for this config if any
    const existing = this.notifiers.get(cacheKey);
    if (existing) {
      await existing.close().catch((err) => {
        this.logger.warn(`Failed to close existing notifier ${cacheKey}: ${err}`);
      });
      this.notifiers.delete(cacheKey);
    }

    // Find matching provider
    const provider = this.providerRegistry.find(
      (p) => p.channel === config.channel && p.provider === config.provider,
    );
    if (!provider) {
      throw new NotFoundException(
        `No NotifierProvider found for channel=${config.channel}, provider=${config.provider}`,
      );
    }

    const rawNotifier = await provider.createNotifier(config);
    // Wrap with event dispatcher proxy (mirrors jetlinks NotifierEventDispatcher)
    const notifier = new NotifierEventDispatcher(rawNotifier, this.eventBus);
    this.notifiers.set(cacheKey, notifier);
    this.logger.log(`Notifier created: ${cacheKey}`);
    return notifier;
  }

  /**
   * Reload a notifier by clearing its cache and publishing reload event.
   * Mirrors jetlinks NotifierManager.reload() + eventBus.publish("/_sys/notifier/reload").
   */
  async reload(configId: string): Promise<void> {
    for (const [key, notifier] of this.notifiers) {
      if (key.endsWith(`:${configId}`)) {
        await notifier.close().catch((err) => {
          this.logger.warn(`Failed to close notifier during reload: ${err}`);
        });
        this.notifiers.delete(key);
        this.logger.log(`Notifier reloaded (cache cleared): ${key}`);
      }
    }

    // Publish reload event for cluster-wide cache invalidation
    if (this.eventBus) {
      try {
        await this.eventBus.publish(NotifierEventTopics.reload, configId);
      } catch (err) {
        this.logger.warn(`Failed to publish notifier reload event: ${err}`);
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.closeAll();
  }

  /**
   * Close all notifiers and release resources.
   */
  async closeAll(): Promise<void> {
    const closePromises = [...this.notifiers.entries()].map(async ([key, notifier]) => {
      try {
        await notifier.close();
      } catch (err) {
        this.logger.warn(`Failed to close notifier ${key}: ${err}`);
      }
    });
    await Promise.all(closePromises);
    this.notifiers.clear();
    this.logger.log('All notifiers closed');
  }
}
