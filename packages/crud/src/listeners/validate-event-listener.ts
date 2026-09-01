/**
 * ValidateEventListener — 实体验证监听器
 * 对齐: hsweb-framework ValidateEventListener.java
 *
 * 监听 PREPARE 阶段事件，对实体进行验证：
 * - CREATE / SAVE → 使用 CreateGroup 规则验证
 * - UPDATE → 使用 UpdateGroup 规则验证
 */
import { Injectable, Optional, Inject, Logger } from '@nestjs/common';
import {
  type EntityEvent,
  type TopicPayload,
  EntityEventPhase,
  EntityEventType,
  type TopicEventBus,
  TOPIC_EVENT_BUS,
} from '@zucker/event';
import {
  type ValidationSchema,
  tryValidate,
  CreateGroup,
  UpdateGroup,
} from '@zucker/core';

/**
 * 实体验证规则注册表
 * 使用方通过 registerSchema() 注册实体的验证规则
 */
export interface EntityValidationRegistry {
  /**
   * 获取指定实体类型的验证规则
   * @param entityType 实体模型名称
   * @param group 验证分组 ('create' | 'update')
   * @returns 验证规则，如果没有注册规则则返回 undefined
   */
  getSchema(entityType: string, group: string): ValidationSchema | undefined;
}

export const ENTITY_VALIDATION_REGISTRY = 'ENTITY_VALIDATION_REGISTRY';

@Injectable()
export class ValidateEventListener {
  private readonly logger = new Logger(ValidateEventListener.name);

  constructor(
    @Optional() @Inject(ENTITY_VALIDATION_REGISTRY)
    private readonly registry?: EntityValidationRegistry,
    @Optional() @Inject(TOPIC_EVENT_BUS)
    private readonly eventBus?: TopicEventBus,
  ) {
    this.registerListeners();
  }

  private registerListeners(): void {
    if (!this.eventBus) return;

    // topic 格式: entity/{entityType}/{type}/{phase}（使用 / 分隔，与 EventBus delimiter 一致）
    // EntityEventType.CREATE = 'create', EntityEventType.SAVE = 'save', EntityEventType.UPDATE/MODIFY = 'modify'
    this.eventBus.subscribe('entity/*/create/prepare', (msg: TopicPayload) => {
      this.handleValidation(msg.payload as EntityEvent, CreateGroup);
    });
    this.eventBus.subscribe('entity/*/save/prepare', (msg: TopicPayload) => {
      this.handleValidation(msg.payload as EntityEvent, CreateGroup);
    });
    this.eventBus.subscribe('entity/*/modify/prepare', (msg: TopicPayload) => {
      this.handleValidation(msg.payload as EntityEvent, UpdateGroup);
    });
  }

  private handleValidation(event: EntityEvent, group: string): void {
    if (event.phase !== EntityEventPhase.PREPARE) return;
    if (!this.registry) return;

    const schema = this.registry.getSchema(event.entityType, group);
    if (!schema) return;

    const entities = Array.isArray(event.entity) ? event.entity : [event.entity];

    for (const entity of entities) {
      if (typeof entity !== 'object' || entity === null) continue;
      tryValidate(entity as Record<string, unknown>, schema);
    }
  }
}

/**
 * 简单的内存验证规则注册表实现
 */
@Injectable()
export class SimpleEntityValidationRegistry implements EntityValidationRegistry {
  private readonly schemas = new Map<string, ValidationSchema>();

  /**
   * 注册实体验证规则
   * @param entityType 实体模型名称
   * @param group 验证分组 ('create' | 'update')
   * @param schema 验证规则
   */
  registerSchema(entityType: string, group: string, schema: ValidationSchema): void {
    this.schemas.set(`${entityType}:${group}`, schema);
  }

  getSchema(entityType: string, group: string): ValidationSchema | undefined {
    return this.schemas.get(`${entityType}:${group}`);
  }
}
