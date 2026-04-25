import { AsyncLocalStorage } from 'async_hooks';
import { EntityEventPhase, EntityEventType, createEntityEvent } from './entity-events';
import type { EntityEvent } from './entity-events';

/**
 * 实体事件帮助器 — 参考 hsweb EntityEventHelper
 *
 * 提供：
 * - doFireEvent 上下文标志（可临时禁用事件发布）
 * - 便捷的事件创建方法
 */

// 使用 AsyncLocalStorage 在异步上下文中传递 "是否触发事件" 标志
// 这是 hsweb 的 Reactor Context 模式在 Node.js 中的等价物
const fireEventStorage = new AsyncLocalStorage<{ flag: boolean }>();

/**
 * 检查当前上下文是否应该触发事件
 * @param defaultIfEmpty 未设置时的默认值（默认 true）
 */
export function isDoFireEvent(defaultIfEmpty = true): boolean {
  const store = fireEventStorage.getStore();
  return store ? store.flag : defaultIfEmpty;
}

/**
 * 在回调范围内禁用事件触发
 *
 * 参考 hsweb EntityEventHelper.setDoNotFireEvent
 *
 * @example
 * ```ts
 * await withoutFireEvent(async () => {
 *   await service.save(entity); // 不会触发实体事件
 * });
 * ```
 */
export async function withoutFireEvent<T>(fn: () => Promise<T>): Promise<T> {
  return fireEventStorage.run({ flag: false }, fn);
}

/**
 * 在回调范围内启用事件触发（用于嵌套恢复）
 */
export async function withFireEvent<T>(fn: () => Promise<T>): Promise<T> {
  return fireEventStorage.run({ flag: true }, fn);
}

/**
 * 尝试触发事件 — 如果当前上下文禁用了事件则跳过
 *
 * 参考 hsweb EntityEventHelper.tryFireEvent
 */
export async function tryFireEvent(task: () => Promise<void>): Promise<void> {
  if (isDoFireEvent(true)) {
    await task();
  }
}

/**
 * 创建并返回一个 EntityEvent，便捷方法
 */
export function createSingleEntityEvent<T>(
  type: EntityEventType,
  phase: EntityEventPhase,
  entityType: string,
  entity: T,
): EntityEvent<T> {
  return createEntityEvent(type, phase, entityType, entity);
}

/**
 * 创建并返回一个批量 EntityEvent
 */
export function createBatchEntityEvent<T>(
  type: EntityEventType,
  phase: EntityEventPhase,
  entityType: string,
  entities: T[],
): EntityEvent<T> {
  return createEntityEvent(type, phase, entityType, entities);
}

/**
 * 创建批量修改事件（带 before/after） — 参考 hsweb EntityEventHelper.publishModifyEvent
 *
 * hsweb 的 EntityModifyEvent 同时包含修改前（before）和修改后（after）的数据列表，
 * 供监听器对比差异或进行审计日志记录。
 *
 * @param phase - 事件阶段
 * @param entityType - 实体类型名称
 * @param before - 修改前的实体列表
 * @param after - 修改后的实体列表
 */
export function createModifyEntityEvent<T>(
  phase: EntityEventPhase,
  entityType: string,
  before: T[],
  after: T[],
): EntityEvent<T> | null {
  // 没有数据被更新则返回 null — 参考 hsweb: if (before.isEmpty()) return Mono.empty()
  if (before.length === 0) {
    return null;
  }
  return createEntityEvent(EntityEventType.MODIFY, phase, entityType, after, before);
}

/**
 * 创建批量创建事件 — 参考 hsweb EntityEventHelper.publishCreatedEvent
 */
export function createCreatedEntityEvent<T>(
  phase: EntityEventPhase,
  entityType: string,
  entities: T[],
): EntityEvent<T> {
  return createEntityEvent(EntityEventType.CREATE, phase, entityType, entities);
}

/**
 * 创建批量删除事件 — 参考 hsweb EntityEventHelper.publishDeletedEvent
 */
export function createDeletedEntityEvent<T>(
  phase: EntityEventPhase,
  entityType: string,
  entities: T[],
): EntityEvent<T> {
  return createEntityEvent(EntityEventType.DELETE, phase, entityType, entities);
}

/**
 * 创建批量保存事件 — 参考 hsweb EntityEventHelper.publishSavedEvent
 */
export function createSavedEntityEvent<T>(
  phase: EntityEventPhase,
  entityType: string,
  entities: T[],
): EntityEvent<T> {
  return createEntityEvent(EntityEventType.SAVE, phase, entityType, entities);
}
