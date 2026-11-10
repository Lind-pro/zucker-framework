/**
 * CreatorEventListener — 创建者自动填充
 *
 * 监听 PREPARE 阶段事件，自动填充审计字段：
 * - CREATE → creatorId, creatorName, createdAt
 * - UPDATE → modifierId, modifierName, updatedAt
 */
import { Injectable, Optional, Inject } from '@nestjs/common';
import {
  type EntityEvent,
  type TopicPayload,
  EntityEventPhase,
  type TopicEventBus,
  TOPIC_EVENT_BUS,
} from '@zucker-framework/event';

export interface CurrentUserProvider {
  getCurrentUserId(): string | undefined;
  getCurrentUserName(): string | undefined;
}

export const CURRENT_USER_PROVIDER = 'CURRENT_USER_PROVIDER';

/** Options for {@link CreatorEventListener} (token {@link CREATOR_LISTENER_OPTIONS}). */
export interface CreatorEventListenerOptions {
  /**
   * Keep caller-supplied creator / timestamp values (legacy `??=` behaviour). Default false:
   * with an authenticated user the creator fields are always assigned from that user, and
   * `creatorId` / `creatorName` / `createdAt` are removed from update payloads.
   */
  trustClientAuditFields?: boolean;
}

export const CREATOR_LISTENER_OPTIONS = 'CREATOR_LISTENER_OPTIONS';

const CREATOR_FIELDS = ['creatorId', 'creatorName', 'createdAt'] as const;

@Injectable()
export class CreatorEventListener {
  constructor(
    @Optional() @Inject(CURRENT_USER_PROVIDER) private readonly userProvider?: CurrentUserProvider,
    @Optional() @Inject(TOPIC_EVENT_BUS) private readonly eventBus?: TopicEventBus,
    @Optional() @Inject(CREATOR_LISTENER_OPTIONS) private readonly options?: CreatorEventListenerOptions,
  ) {
    this.registerListeners();
  }

  private registerListeners(): void {
    if (!this.eventBus) return;

    // 监听实体事件的 PREPARE 阶段，自动填充审计字段
    // topic 格式: entity/{entityType}/{type}/{phase}（使用 / 分隔，与 EventBus delimiter 一致）
    this.eventBus.subscribe('entity/*/create/prepare', (msg: TopicPayload) => {
      this.handleCreate(msg.payload as EntityEvent);
    });
    this.eventBus.subscribe('entity/*/save/prepare', (msg: TopicPayload) => {
      this.handleSave(msg.payload as EntityEvent);
    });
    this.eventBus.subscribe('entity/*/modify/prepare', (msg: TopicPayload) => {
      this.handleUpdate(msg.payload as EntityEvent);
    });
  }

  private records(event: EntityEvent): Record<string, unknown>[] {
    const entities = Array.isArray(event.entity) ? event.entity : [event.entity];
    return entities.filter((entity): entity is Record<string, unknown> => typeof entity === 'object' && entity !== null);
  }

  private fillCreator(rec: Record<string, unknown>, userId?: string, userName?: string, now = new Date()): void {
    const trust = this.options?.trustClientAuditFields;
    if (userId !== undefined && !trust) {
      rec.creatorId = userId;
      rec.creatorName = userName;
    } else {
      rec.creatorId ??= userId;
      rec.creatorName ??= userName;
    }
    rec.createdAt ??= now;
    rec.modifierId = userId ?? rec.modifierId;
    rec.modifierName = userName ?? rec.modifierName;
    rec.updatedAt ??= now;
  }

  private fillModifier(rec: Record<string, unknown>, userId?: string, userName?: string): void {
    if (!this.options?.trustClientAuditFields) {
      // The creator of an existing row never changes through an update.
      for (const field of CREATOR_FIELDS) delete rec[field];
    }
    rec.modifierId = userId;
    rec.modifierName = userName;
    rec.updatedAt = new Date();
  }

  private handleCreate(event: EntityEvent): void {
    if (event.phase !== EntityEventPhase.PREPARE) return;
    const userId = this.userProvider?.getCurrentUserId();
    const userName = this.userProvider?.getCurrentUserName();
    const now = new Date();
    for (const rec of this.records(event)) this.fillCreator(rec, userId, userName, now);
  }

  /**
   * SAVE is an upsert: entities without an id are creates; entities with an id may update an
   * existing row, so only modifier fields are written for them (creator fields are left untouched
   * rather than rewritten to the current user / now).
   */
  private handleSave(event: EntityEvent): void {
    if (event.phase !== EntityEventPhase.PREPARE) return;
    const userId = this.userProvider?.getCurrentUserId();
    const userName = this.userProvider?.getCurrentUserName();
    const now = new Date();
    for (const rec of this.records(event)) {
      if (rec.id) this.fillModifier(rec, userId, userName);
      else this.fillCreator(rec, userId, userName, now);
    }
  }

  private handleUpdate(event: EntityEvent): void {
    if (event.phase !== EntityEventPhase.PREPARE) return;
    const userId = this.userProvider?.getCurrentUserId();
    const userName = this.userProvider?.getCurrentUserName();
    for (const rec of this.records(event)) this.fillModifier(rec, userId, userName);
  }
}
