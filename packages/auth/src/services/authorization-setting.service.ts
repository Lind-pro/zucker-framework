import { Injectable, Inject, Logger, Optional } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { DatabaseAdapter } from '@zucker/core';
import { DimensionService } from './dimension.service';
import {
  AUTH_EVENT_TOPICS,
  createClearAuthCacheEvent,
  type DimensionDeletedEvent,
} from '../events/auth-events';

/** Minimal TopicEventBus interface to avoid hard dependency on @zucker/event */
interface TopicEventBusLike {
  publish(topic: string, payload: unknown): Promise<void>;
  subscribe?(topic: string, handler: (payload: unknown) => void | Promise<void>): void;
}

/**
 * Authorization setting entity shape.
 * Each row maps a permission to a dimension (role/department/etc.)
 * with specific action access.
 *
 * Reference: hsweb AuthorizationSettingEntity
 */
export interface AuthorizationSettingEntity {
  id: string;
  permission: string;
  dimensionType: string;
  dimensionTarget: string;
  /** JSON: the granted actions for this permission+dimension combination */
  actions?: unknown;
  /** JSON: data access configurations */
  dataAccesses?: unknown;
  /** Merge flag: true = merge with other dimension settings */
  merge?: boolean;
  /** Priority: higher = higher precedence when merging */
  priority?: number;
  status?: number;
}

import { DATABASE_ADAPTER } from '@zucker/crud';
const TOPIC_EVENT_BUS = 'TOPIC_EVENT_BUS';

/**
 * AuthorizationSettingService -- corresponds to hsweb DefaultAuthorizationSettingService.
 *
 * Manages the mapping between permissions and dimensions (roles, departments, etc.).
 * - Generates deterministic IDs from permission + dimensionType + dimensionTarget
 * - Clears user authorization cache when settings are modified
 * - Cascade-deletes settings when a dimension is deleted
 *
 * Reference: hsweb-system-authorization DefaultAuthorizationSettingService
 */
@Injectable()
export class AuthorizationSettingService {
  private readonly logger = new Logger(AuthorizationSettingService.name);

  constructor(
    @Inject(DATABASE_ADAPTER) private readonly db: DatabaseAdapter,
    @Optional() private readonly dimensionService?: DimensionService,
    @Optional() @Inject(TOPIC_EVENT_BUS) private readonly topicEventBus?: TopicEventBusLike,
  ) {
    // Subscribe to dimension deletion events for cascade cleanup
    if (this.topicEventBus?.subscribe) {
      this.topicEventBus.subscribe(
        AUTH_EVENT_TOPICS.DIMENSION_DELETED,
        (payload) => this.handleDimensionDeleted(payload as DimensionDeletedEvent),
      );
    }
  }

  /**
   * Generate a deterministic ID for an authorization setting.
   *
   * Reference: hsweb DefaultAuthorizationSettingService.generateId()
   * -- uses DigestUtils.md5Hex(permission + dimensionType + dimensionTarget)
   */
  generateId(entity: Pick<AuthorizationSettingEntity, 'permission' | 'dimensionType' | 'dimensionTarget'>): string {
    const input = `${entity.permission}${entity.dimensionType}${entity.dimensionTarget}`;
    return createHash('md5').update(input).digest('hex');
  }

  /**
   * Save (upsert) one or more authorization settings.
   * Auto-generates IDs if not set.
   *
   * Reference: hsweb DefaultAuthorizationSettingService.save()
   */
  async save(
    settings: AuthorizationSettingEntity | AuthorizationSettingEntity[],
  ): Promise<number> {
    const items = Array.isArray(settings) ? settings : [settings];
    let count = 0;

    for (const item of items) {
      if (!item.id) {
        item.id = this.generateId(item);
      }

      try {
        const existing = await this.db.model('authorizationSettings').findUnique({
          where: { id: item.id },
        });

        if (existing) {
          await this.db.model('authorizationSettings').update({
            where: { id: item.id },
            data: item,
          });
        } else {
          await this.db.model('authorizationSettings').create({ data: item });
        }
        count++;
      } catch (err) {
        this.logger.warn(`Failed to save authorization setting ${item.id}: ${err}`);
      }
    }

    // Clear affected users' auth cache
    await this.clearUserAuthCache(items);

    return count;
  }

  /**
   * Delete authorization settings by IDs.
   */
  async deleteByIds(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;

    // Load entities before delete for cache clearing
    const entities = (await this.db.model('authorizationSettings').findMany({
      where: { id: { in: ids } },
    })) as AuthorizationSettingEntity[];

    let count = 0;
    for (const id of ids) {
      try {
        await this.db.model('authorizationSettings').delete({ where: { id } });
        count++;
      } catch {
        // skip non-existent
      }
    }

    // Clear affected users' auth cache
    if (entities.length > 0) {
      await this.clearUserAuthCache(entities);
    }

    return count;
  }

  /**
   * Find settings by dimension type and target.
   */
  async findByDimension(
    dimensionType: string,
    dimensionTarget: string,
  ): Promise<AuthorizationSettingEntity[]> {
    return this.db.model('authorizationSettings').findMany({
      where: { dimensionType, dimensionTarget },
    }) as Promise<AuthorizationSettingEntity[]>;
  }

  /**
   * Find settings by permission ID.
   */
  async findByPermission(permissionId: string): Promise<AuthorizationSettingEntity[]> {
    return this.db.model('authorizationSettings').findMany({
      where: { permission: permissionId },
    }) as Promise<AuthorizationSettingEntity[]>;
  }

  /**
   * Clear user authorization cache for users affected by setting changes.
   *
   * Reference: hsweb DefaultAuthorizationSettingService.clearUserAuthCache()
   * -- resolves dimension providers to find all affected user IDs,
   *    then publishes ClearUserAuthorizationCacheEvent
   */
  private async clearUserAuthCache(settings: AuthorizationSettingEntity[]): Promise<void> {
    if (!this.topicEventBus) return;

    if (!this.dimensionService) {
      // If no dimension service, clear all caches
      await this.topicEventBus.publish(
        AUTH_EVENT_TOPICS.CLEAR_AUTH_CACHE,
        createClearAuthCacheEvent(undefined, 'authorization_setting_changed'),
      );
      return;
    }

    // Collect all affected user IDs via dimension providers
    const userIds = new Set<string>();
    for (const setting of settings) {
      try {
        const ids = await this.dimensionService.getUserIdsByDimensionId(
          setting.dimensionTarget,
        );
        ids.forEach((id) => userIds.add(id));
      } catch {
        // If we can't resolve users, clear all
        await this.topicEventBus.publish(
          AUTH_EVENT_TOPICS.CLEAR_AUTH_CACHE,
          createClearAuthCacheEvent(undefined, 'authorization_setting_changed'),
        );
        return;
      }
    }

    // Clear cache for each affected user
    for (const userId of userIds) {
      await this.topicEventBus.publish(
        AUTH_EVENT_TOPICS.CLEAR_AUTH_CACHE,
        createClearAuthCacheEvent(userId, 'authorization_setting_changed'),
      );
    }
  }

  /**
   * Handle dimension deletion -- cascade delete associated authorization settings.
   *
   * Reference: hsweb DefaultAuthorizationSettingService.handleDimensionAdd() / handleDimensionDeletedEvent()
   */
  private async handleDimensionDeleted(event: DimensionDeletedEvent): Promise<void> {
    try {
      const settings = (await this.db.model('authorizationSettings').findMany({
        where: {
          dimensionType: event.dimensionType,
          dimensionTarget: event.dimensionId,
        },
      })) as AuthorizationSettingEntity[];

      if (settings.length > 0) {
        for (const setting of settings) {
          await this.db.model('authorizationSettings').delete({
            where: { id: setting.id },
          });
        }
        this.logger.log(
          `Deleted ${settings.length} authorization settings for deleted dimension ${event.dimensionType}:${event.dimensionId}`,
        );
      }
    } catch (err) {
      this.logger.warn(`Failed to cascade delete authorization settings: ${err}`);
    }
  }
}
