import { EntityEvent, EntityEventPhase, EntityEventType } from './entity-events';

export interface EntityEventListener<T = unknown> {
  onEvent(event: EntityEvent<T>): void | Promise<void>;

  /**
   * 监听器优先级，数值越小优先级越高
   * 默认 0
   */
  readonly order?: number;
}

/**
 * 当前用户信息
 */
export interface CurrentUser {
  id: string;
  name?: string;
}

/** Options for {@link CreatorEventListener}. */
export interface CreatorEventListenerOptions {
  /**
   * Keep caller-supplied creator fields (legacy `??=` behaviour). Default false: the current user
   * is always written as creator on create, and creator fields are stripped from updates.
   */
  trustClientAuditFields?: boolean;
}

/**
 * 创建者监听器 - Prepare 阶段自动填充创建人/修改人信息
 *
 * - CREATE: 以当前用户覆盖 creatorId / creatorName（不信任调用方传入值），createdAt 未设置时填充
 * - SAVE: 无 id 的实体按创建处理；有 id 的实体（可能是已有记录）只填充修改人
 * - MODIFY/UPDATE: 填充 modifierId, modifierName, updatedAt，并移除 creatorId/creatorName/createdAt
 * - 无当前用户（系统任务）时不修改实体
 * - order 为最高优先级（HIGHEST_PRECEDENCE）
 */
export class CreatorEventListener implements EntityEventListener {
  readonly order = -Infinity; // HIGHEST_PRECEDENCE

  constructor(
    private readonly getCurrentUser: () => CurrentUser | undefined,
    private readonly options: CreatorEventListenerOptions = {},
  ) {}

  async onEvent(event: EntityEvent): Promise<void> {
    if (event.phase !== EntityEventPhase.PREPARE) return;

    const user = this.getCurrentUser();
    if (!user) return;

    const entities = Array.isArray(event.entity) ? event.entity : [event.entity];
    const now = new Date();
    const trust = this.options.trustClientAuditFields === true;

    for (const entity of entities) {
      if (typeof entity !== 'object' || entity === null) continue;
      const rec = entity as Record<string, unknown>;

      const isCreate = event.type === EntityEventType.CREATE
        || (event.type === EntityEventType.SAVE && !rec.id);
      const isModify = (event.type as string) === EntityEventType.MODIFY
        || (event.type === EntityEventType.SAVE && !!rec.id);

      if (isCreate) {
        if (trust) {
          rec.creatorId ??= user.id;
          if (user.name !== undefined) rec.creatorName ??= user.name;
        } else {
          rec.creatorId = user.id;
          if (user.name !== undefined) rec.creatorName = user.name;
          else delete rec.creatorName;
        }
        rec.createdAt ??= now;
      } else if (isModify && !trust) {
        delete rec.creatorId;
        delete rec.creatorName;
        delete rec.createdAt;
      }

      if ((isModify || isCreate) && !trust) {
        rec.modifierId = user.id;
        if (user.name !== undefined) rec.modifierName = user.name;
        rec.updatedAt = now;
      } else if (isModify || isCreate) {
        // 修改人信息 — 仅在未设置时填充（trustClientAuditFields）
        if (rec.modifierId == null || rec.modifierId === '' || rec.modifierId === undefined) {
          rec.modifierId = user.id;
        }
        if (user.name !== undefined) {
          if (rec.modifierName == null || rec.modifierName === '' || rec.modifierName === undefined) {
            rec.modifierName = user.name;
          }
        }
        rec.updatedAt ??= now;
      }
    }
  }
}

/**
 * 组合事件监听器
 *
 * 聚合多个 EntityEventListener 并按 order 排序执行。
 * 数值越小优先级越高。
 */
export class CompositeEventListener<T = unknown> implements EntityEventListener<T> {
  private listeners: EntityEventListener<T>[] = [];

  addListener(listener: EntityEventListener<T>): void {
    this.listeners.push(listener);
    this.listeners.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }

  removeListener(listener: EntityEventListener<T>): void {
    const idx = this.listeners.indexOf(listener);
    if (idx >= 0) this.listeners.splice(idx, 1);
  }

  async onEvent(event: EntityEvent<T>): Promise<void> {
    for (const listener of this.listeners) {
      await listener.onEvent(event);
    }
  }

  getListeners(): readonly EntityEventListener<T>[] {
    return this.listeners;
  }
}
