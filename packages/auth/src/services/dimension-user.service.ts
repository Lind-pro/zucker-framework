import { Injectable, Inject, Logger, Optional } from '@nestjs/common';
import type { DatabaseAdapter } from '@zucker/core';
import {
  AUTH_EVENT_TOPICS,
  createDimensionBindEvent,
  createDimensionUnbindEvent,
  createClearAuthCacheEvent,
  type UserDeletedEvent,
  type DimensionDeletedEvent,
} from '../events/auth-events';

/** Minimal TopicEventBus interface to avoid hard dependency on @zucker/event */
interface TopicEventBusLike {
  publish(topic: string, payload: unknown): Promise<void>;
  subscribe?(topic: string, handler: (payload: unknown) => void | Promise<void>): void;
}

/**
 * Dimension-user binding entity.
 *
 * Reference: hsweb DimensionUserEntity
 */
export interface DimensionUserEntity {
  id: string;
  userId: string;
  dimensionTypeId: string;
  dimensionId: string;
  dimensionName?: string;
}

import { DATABASE_ADAPTER } from '@zucker/crud';
const TOPIC_EVENT_BUS = 'TOPIC_EVENT_BUS';

/**
 * DimensionUserService -- corresponds to hsweb DefaultDimensionUserService.
 *
 * Manages the binding between users and dimensions (roles, departments, etc.).
 * Publishes bind/unbind events and handles cascade deletions.
 *
 * Key behaviors from hsweb:
 * - User deleted -> delete all dimension bindings for that user
 * - Dimension entity deleted -> delete all bindings for that dimension
 * - Binding saved/created -> publish DimensionBindEvent + clear auth cache
 * - Binding deleted -> publish DimensionUnbindEvent + clear auth cache
 * - Binding modified -> clear auth cache
 *
 * Reference: hsweb-system-authorization DefaultDimensionUserService
 */
@Injectable()
export class DimensionUserService {
  private readonly logger = new Logger(DimensionUserService.name);

  constructor(
    @Inject(DATABASE_ADAPTER) private readonly db: DatabaseAdapter,
    @Optional() @Inject(TOPIC_EVENT_BUS) private readonly topicEventBus?: TopicEventBusLike,
  ) {
    // Subscribe to cascade events
    if (this.topicEventBus?.subscribe) {
      this.topicEventBus.subscribe(
        AUTH_EVENT_TOPICS.USER_DELETED,
        (payload) => this.handleUserDeleted(payload as UserDeletedEvent),
      );
      this.topicEventBus.subscribe(
        AUTH_EVENT_TOPICS.DIMENSION_DELETED,
        (payload) => this.handleDimensionDeleted(payload as DimensionDeletedEvent),
      );
    }
  }

  /**
   * Bind a user to a dimension.
   *
   * Reference: hsweb DefaultDimensionUserService entity save -> DimensionBindEvent
   */
  async bind(data: {
    userId: string;
    dimensionTypeId: string;
    dimensionId: string;
    dimensionName?: string;
  }): Promise<DimensionUserEntity> {
    const entity = (await this.db.model('dimensionUsers').create({
      data,
    })) as DimensionUserEntity;

    // Publish DimensionBindEvent
    await this.publishEvent(
      AUTH_EVENT_TOPICS.DIMENSION_BIND,
      createDimensionBindEvent(
        data.userId,
        data.dimensionTypeId,
        data.dimensionId,
      ),
    );

    // Clear user auth cache
    await this.clearUserCache([data.userId]);

    return entity;
  }

  /**
   * Batch bind users to dimensions.
   *
   * Reference: hsweb DefaultDimensionUserService entity save batch
   */
  async bindBatch(
    bindings: Array<{
      userId: string;
      dimensionTypeId: string;
      dimensionId: string;
      dimensionName?: string;
    }>,
  ): Promise<DimensionUserEntity[]> {
    const results: DimensionUserEntity[] = [];
    const affectedUserIds = new Set<string>();

    for (const data of bindings) {
      const entity = (await this.db.model('dimensionUsers').create({
        data,
      })) as DimensionUserEntity;
      results.push(entity);
      affectedUserIds.add(data.userId);

      // Publish DimensionBindEvent per binding
      await this.publishEvent(
        AUTH_EVENT_TOPICS.DIMENSION_BIND,
        createDimensionBindEvent(
          data.userId,
          data.dimensionTypeId,
          data.dimensionId,
        ),
      );
    }

    // Clear auth cache for all affected users
    await this.clearUserCache(Array.from(affectedUserIds));

    return results;
  }

  /**
   * Unbind a user from a dimension.
   *
   * Reference: hsweb DefaultDimensionUserService entity delete -> DimensionUnbindEvent
   */
  async unbind(id: string): Promise<boolean> {
    // Load entity before delete for event publishing
    const entity = (await this.db.model('dimensionUsers').findUnique({
      where: { id },
    })) as DimensionUserEntity | null;

    if (!entity) return false;

    await this.db.model('dimensionUsers').delete({ where: { id } });

    // Publish DimensionUnbindEvent
    await this.publishEvent(
      AUTH_EVENT_TOPICS.DIMENSION_UNBIND,
      createDimensionUnbindEvent(
        entity.userId,
        entity.dimensionTypeId,
        entity.dimensionId,
      ),
    );

    // Clear user auth cache
    await this.clearUserCache([entity.userId]);

    return true;
  }

  /**
   * Find all bindings for a user.
   */
  async findByUserId(userId: string): Promise<DimensionUserEntity[]> {
    return this.db.model('dimensionUsers').findMany({
      where: { userId },
    }) as Promise<DimensionUserEntity[]>;
  }

  /**
   * Find all bindings for a dimension.
   */
  async findByDimensionId(dimensionId: string): Promise<DimensionUserEntity[]> {
    return this.db.model('dimensionUsers').findMany({
      where: { dimensionId },
    }) as Promise<DimensionUserEntity[]>;
  }

  /**
   * Get user IDs bound to a specific dimension.
   */
  async getUserIdsByDimensionId(dimensionId: string): Promise<string[]> {
    const bindings = (await this.db.model('dimensionUsers').findMany({
      where: { dimensionId },
      select: { userId: true },
    })) as Array<{ userId: string }>;
    return bindings.map((b) => b.userId);
  }

  /**
   * Get dimension bind info for multiple users.
   *
   * Reference: hsweb DefaultDimensionService.getDimensionBindInfo()
   */
  async getDimensionBindInfo(
    userIds: string[],
  ): Promise<Array<{ userId: string; dimensionTypeId: string; dimensionId: string }>> {
    if (userIds.length === 0) return [];
    const bindings = (await this.db.model('dimensionUsers').findMany({
      where: { userId: { in: userIds } },
    })) as DimensionUserEntity[];
    return bindings.map((b) => ({
      userId: b.userId,
      dimensionTypeId: b.dimensionTypeId,
      dimensionId: b.dimensionId,
    }));
  }

  /**
   * Handle user deletion -- cascade delete all dimension bindings.
   *
   * Reference: hsweb DefaultDimensionUserService.handleUserDeleteEntity()
   */
  private async handleUserDeleted(event: UserDeletedEvent): Promise<void> {
    try {
      const bindings = (await this.db.model('dimensionUsers').findMany({
        where: { userId: event.userId },
      })) as DimensionUserEntity[];

      if (bindings.length > 0) {
        for (const binding of bindings) {
          await this.db.model('dimensionUsers').delete({
            where: { id: binding.id },
          });
        }
        this.logger.debug(
          `User deleted, cleared ${bindings.length} dimension bindings for user ${event.userId}`,
        );
      }
    } catch (err) {
      this.logger.warn(`Failed to cascade delete dimension bindings: ${err}`);
    }
  }

  /**
   * Handle dimension entity deletion -- cascade delete all user bindings.
   *
   * Reference: hsweb DefaultDimensionUserService.handleDimensionDeletedEntity()
   */
  private async handleDimensionDeleted(event: DimensionDeletedEvent): Promise<void> {
    try {
      const bindings = (await this.db.model('dimensionUsers').findMany({
        where: {
          dimensionTypeId: event.dimensionType,
          dimensionId: event.dimensionId,
        },
      })) as DimensionUserEntity[];

      if (bindings.length > 0) {
        const affectedUserIds = new Set<string>();
        for (const binding of bindings) {
          await this.db.model('dimensionUsers').delete({
            where: { id: binding.id },
          });
          affectedUserIds.add(binding.userId);
        }

        // Clear auth cache for affected users
        await this.clearUserCache(Array.from(affectedUserIds));

        this.logger.debug(
          `Dimension deleted, cleared ${bindings.length} user bindings for ${event.dimensionType}:${event.dimensionId}`,
        );
      }
    } catch (err) {
      this.logger.warn(`Failed to cascade delete user dimension bindings: ${err}`);
    }
  }

  /**
   * Clear authorization cache for affected users.
   *
   * Reference: hsweb DefaultDimensionUserService.clearUserCache()
   */
  private async clearUserCache(userIds: string[]): Promise<void> {
    if (!this.topicEventBus || userIds.length === 0) return;

    for (const userId of userIds) {
      await this.publishEvent(
        AUTH_EVENT_TOPICS.CLEAR_AUTH_CACHE,
        createClearAuthCacheEvent(userId, 'dimension_binding_changed'),
      );
    }
  }

  private async publishEvent(topic: string, payload: unknown): Promise<void> {
    if (this.topicEventBus) {
      try {
        await this.topicEventBus.publish(topic, payload);
      } catch (err) {
        this.logger.warn(`Failed to publish event ${topic}: ${err}`);
      }
    }
  }
}
