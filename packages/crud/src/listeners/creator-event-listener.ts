/**
 * CreatorEventListener — 创建者自动填充
 * 参考: hsweb-framework CreatorEventListener.java
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
  EntityEventType,
  type TopicEventBus,
  TOPIC_EVENT_BUS,
} from '@zucker/event';

export interface CurrentUserProvider {
  getCurrentUserId(): string | undefined;
  getCurrentUserName(): string | undefined;
}

export const CURRENT_USER_PROVIDER = 'CURRENT_USER_PROVIDER';

@Injectable()
export class CreatorEventListener {
  constructor(
    @Optional() @Inject(CURRENT_USER_PROVIDER) private readonly userProvider?: CurrentUserProvider,
    @Optional() @Inject(TOPIC_EVENT_BUS) private readonly eventBus?: TopicEventBus,
  ) {
    this.registerListeners();
  }

  private registerListeners(): void {
    if (!this.eventBus) return;

    // 监听实体事件的 PREPARE 阶段，自动填充审计字段
    // topic 格式: entity/{entityType}/{type}/{phase}（使用 / 分隔，与 EventBus delimiter 一致）
    // EntityEventType.CREATE = 'create', EntityEventType.UPDATE/MODIFY = 'modify', EntityEventType.SAVE = 'save'
    this.eventBus.subscribe('entity/*/create/prepare', (msg: TopicPayload) => {
      this.handleCreate(msg.payload as EntityEvent);
    });
    this.eventBus.subscribe('entity/*/save/prepare', (msg: TopicPayload) => {
      this.handleCreate(msg.payload as EntityEvent);
    });
    this.eventBus.subscribe('entity/*/modify/prepare', (msg: TopicPayload) => {
      this.handleUpdate(msg.payload as EntityEvent);
    });
  }

  private handleCreate(event: EntityEvent): void {
    if (event.phase !== EntityEventPhase.PREPARE) return;

    const entities = Array.isArray(event.entity) ? event.entity : [event.entity];
    const userId = this.userProvider?.getCurrentUserId();
    const userName = this.userProvider?.getCurrentUserName();
    const now = new Date();

    for (const entity of entities) {
      if (typeof entity !== 'object' || entity === null) continue;
      const rec = entity as Record<string, unknown>;
      rec.creatorId ??= userId;
      rec.creatorName ??= userName;
      rec.createdAt ??= now;
      // 创建时也填充 modifier 字段
      rec.modifierId ??= userId;
      rec.modifierName ??= userName;
      rec.updatedAt ??= now;
    }
  }

  private handleUpdate(event: EntityEvent): void {
    if (event.phase !== EntityEventPhase.PREPARE) return;

    const entities = Array.isArray(event.entity) ? event.entity : [event.entity];
    const userId = this.userProvider?.getCurrentUserId();
    const userName = this.userProvider?.getCurrentUserName();

    for (const entity of entities) {
      if (typeof entity !== 'object' || entity === null) continue;
      const rec = entity as Record<string, unknown>;
      rec.modifierId = userId;
      rec.modifierName = userName;
      rec.updatedAt = new Date();
    }
  }
}
