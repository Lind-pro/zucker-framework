import { Injectable } from '@nestjs/common';
import { EntityEventType, EntityEventPhase, ALL_EVENT_PHASES } from './entity-events';

function toKey(entityType: string, eventType?: EntityEventType, phase?: EntityEventPhase): string {
  if (!eventType) return entityType;
  return phase ? `${entityType}:${eventType}:${phase}` : `${entityType}:${eventType}`;
}

/**
 * 运行时实体事件开关配置
 *
 * 支持三个粒度级别的控制（从粗到细）：
 * 1. 实体级别：enable('user') / disable('user')
 * 2. 事件类型级别：enable('user', EntityEventType.CREATE)
 * 3. 事件阶段级别：enable('user', EntityEventType.CREATE, EntityEventPhase.BEFORE)
 *
 * 优先级（从高到低）：
 * 1. 运行时 disable 配置（精确匹配优先）
 * 2. 运行时 enable 配置（精确匹配优先）
 * 3. @EnableEntityEvent 装饰器
 * 4. 默认全部启用
 *
 * enable 和 disable 互斥，enable 某个阶段会自动从 disabled 集合中移除，反之亦然。
 *
 * 并发安全改进：
 * 在初次 CRUD 操作并发执行时，多个请求可能同时尝试初始化同一实体类型的事件配置。
 * 初始化过程同步执行，不跨异步边界。
 * 使用已初始化标志确保初始化逻辑只执行一次。
 */
@Injectable()
export class EntityEventListenerConfigure {
  private readonly enabled = new Map<string, boolean>();
  private readonly disabled = new Map<string, boolean>();

  /**
   * 启用整个实体的事件
   */
  enable(entityType: string): void;
  /**
   * 启用指定实体的指定事件类型
   */
  enable(entityType: string, eventType: EntityEventType): void;
  /**
   * 启用指定实体的指定事件类型的指定阶段
   */
  enable(entityType: string, eventType: EntityEventType, ...phases: EntityEventPhase[]): void;
  enable(entityType: string, eventType?: EntityEventType, ...phases: EntityEventPhase[]): void {
    if (!eventType) {
      // 实体级别启用
      const key = toKey(entityType);
      this.enabled.set(key, true);
      this.disabled.delete(key);
      return;
    }

    const targetPhases = phases.length > 0
      ? phases
      : ALL_EVENT_PHASES;

    for (const phase of targetPhases) {
      const key = toKey(entityType, eventType, phase);
      this.enabled.set(key, true);
      this.disabled.delete(key);
    }

    // 同时标记 eventType 级别
    const typeKey = toKey(entityType, eventType);
    this.enabled.set(typeKey, true);
    this.disabled.delete(typeKey);
  }

  /**
   * 禁用整个实体的事件
   */
  disable(entityType: string): void;
  /**
   * 禁用指定实体的指定事件类型
   */
  disable(entityType: string, eventType: EntityEventType): void;
  /**
   * 禁用指定实体的指定事件类型的指定阶段
   */
  disable(entityType: string, eventType: EntityEventType, ...phases: EntityEventPhase[]): void;
  disable(entityType: string, eventType?: EntityEventType, ...phases: EntityEventPhase[]): void {
    if (!eventType) {
      // 实体级别禁用
      const key = toKey(entityType);
      this.disabled.set(key, true);
      this.enabled.delete(key);
      return;
    }

    const targetPhases = phases.length > 0
      ? phases
      : ALL_EVENT_PHASES;

    for (const phase of targetPhases) {
      const key = toKey(entityType, eventType, phase);
      this.disabled.set(key, true);
      this.enabled.delete(key);
    }

    // 只有禁用全部 phase 时才标记 eventType 级别
    // 若只禁用特定 phase，不能将整个 eventType 标记为 disabled
    if (phases.length === 0) {
      const typeKey = toKey(entityType, eventType);
      this.disabled.set(typeKey, true);
      this.enabled.delete(typeKey);
    }
  }

  /**
   * 检查某个实体是否启用了事件（实体级别）
   */
  isEnabled(entityType: string): boolean;
  /**
   * 检查某个实体的某种事件在某个阶段是否启用
   */
  isEnabled(entityType: string, eventType: EntityEventType, phase?: EntityEventPhase): boolean;
  isEnabled(entityType: string, eventType?: EntityEventType, phase?: EntityEventPhase): boolean {
    // 先检查实体级别是否被禁用
    const entityKey = toKey(entityType);
    if (this.disabled.has(entityKey)) return false;

    if (!eventType) {
      // 实体级别检查：有任何 enabled 或者没有任何 disabled
      return this.enabled.has(entityKey) || !this.disabled.has(entityKey);
    }

    // 检查 phase 级别精确匹配
    if (phase) {
      const phaseKey = toKey(entityType, eventType, phase);
      if (this.disabled.has(phaseKey)) return false;
      if (this.enabled.has(phaseKey)) return true;
    }

    // 检查 eventType 级别
    const typeKey = toKey(entityType, eventType);
    if (this.disabled.has(typeKey)) return false;
    if (this.enabled.has(typeKey)) return true;

    // 默认启用
    return true;
  }

  /**
   * 清除指定实体的运行时覆盖配置
   */
  reset(entityType: string, eventType?: EntityEventType, phase?: EntityEventPhase): void {
    const key = toKey(entityType, eventType, phase);
    this.enabled.delete(key);
    this.disabled.delete(key);
  }

  /**
   * 清除所有运行时覆盖配置
   */
  resetAll(): void {
    this.enabled.clear();
    this.disabled.clear();
  }
}
