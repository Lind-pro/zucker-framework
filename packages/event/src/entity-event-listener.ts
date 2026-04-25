import { EntityEvent, EntityEventPhase, EntityEventType } from './entity-events';

export interface EntityEventListener<T = unknown> {
  onEvent(event: EntityEvent<T>): void | Promise<void>;

  /**
   * 监听器优先级，数值越小优先级越高（与 hsweb Ordered 一致）
   * 默认 0
   */
  readonly order?: number;
}

/**
 * 当前用户信息 — 参考 hsweb Authentication
 */
export interface CurrentUser {
  id: string;
  name?: string;
}

/**
 * 创建者监听器 - Prepare 阶段自动填充创建人/修改人信息
 *
 * 参考 hsweb CreatorEventListener:
 * - CREATE/SAVE: 填充 creatorId, creatorName, createdAt, modifierId, modifierName, updatedAt
 * - MODIFY/UPDATE: 仅填充 modifierId, modifierName, updatedAt
 *
 * 与 hsweb 一致点：
 * - 使用 ??= 确保不覆盖已有的 creatorId（用户可提前设置）
 * - modifierId/modifierName 始终覆盖
 * - order 为最高优先级（HIGHEST_PRECEDENCE）
 */
export class CreatorEventListener implements EntityEventListener {
  readonly order = -Infinity; // HIGHEST_PRECEDENCE

  constructor(
    private readonly getCurrentUser: () => CurrentUser | undefined,
  ) {}

  async onEvent(event: EntityEvent): Promise<void> {
    if (event.phase !== EntityEventPhase.PREPARE) return;

    const user = this.getCurrentUser();
    if (!user) return;

    const entities = Array.isArray(event.entity) ? event.entity : [event.entity];
    const now = new Date();

    const isCreate = event.type === EntityEventType.CREATE || event.type === EntityEventType.SAVE;
    const isModify = (event.type as string) === EntityEventType.MODIFY
      || event.type === EntityEventType.SAVE;

    for (const entity of entities) {
      if (typeof entity !== 'object' || entity === null) continue;
      const rec = entity as Record<string, unknown>;

      if (isCreate) {
        // 创建人信息 — 仅在未设置时填充
        rec.creatorId ??= user.id;
        if (user.name !== undefined) {
          rec.creatorName ??= user.name;
        }
        rec.createdAt ??= now;
      }

      if (isModify || isCreate) {
        // 修改人信息 — 仅在未设置时填充（与 hsweb ObjectUtils.isEmpty 检查一致）
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
 * 组合事件监听器 — 参考 hsweb CompositeEventListener
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
