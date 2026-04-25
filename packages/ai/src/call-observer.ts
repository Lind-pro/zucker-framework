import { Injectable } from '@nestjs/common';

/**
 * AI 调用基础事件。
 *
 * 由 AICallWrapper 在每次调用（含 retry）成功或失败时发出。
 * 实现方可订阅以接入日志 / 审计 / 监控 / 成本追踪等横切关注点。
 */
export interface AICallEvent {
  /** 调用上下文（来自 CallOptions.context）*/
  context: string;
  /** 开始时间（Date.now()）*/
  startTime: number;
  /** 实际耗时（毫秒）*/
  durationMs: number;
  /** 第几次尝试（含重试，从 1 开始）*/
  attempt: number;
  /** 调用方自定义元数据（来自 CallOptions.metadata）*/
  metadata?: Record<string, unknown>;
}

export interface AICallSuccessEvent<T = unknown> extends AICallEvent {
  result: T;
}

export interface AICallErrorEvent extends AICallEvent {
  error: Error;
}

/**
 * AI 调用观察者接口。
 *
 * 可订阅成功 / 失败事件，框架不绑定具体日志实现。
 * 实现方按需重写 onSuccess 或 onError（都可选；但都不实现等于空 observer）。
 *
 * @example
 * ```ts
 * class OperationLogObserver implements AICallObserver {
 *   constructor(private readonly opLog: OperationLogService) {}
 *
 *   async onSuccess(e: AICallSuccessEvent) {
 *     await this.opLog.log({ module: 'ai', action: e.context, status: 'SUCCESS', ... });
 *   }
 *
 *   async onError(e: AICallErrorEvent) {
 *     await this.opLog.log({ module: 'ai', action: e.context, status: 'FAILED', error: e.error });
 *   }
 * }
 *
 * registry.register(new OperationLogObserver(opLog));
 * ```
 */
export interface AICallObserver {
  onSuccess?(event: AICallSuccessEvent): void | Promise<void>;
  onError?(event: AICallErrorEvent): void | Promise<void>;
}

/**
 * Observer 注册表。
 *
 * 由 AICallWrapper 注入并通知。一个 observer 抛错不影响其他 observer，
 * 也不影响主流程。
 */
@Injectable()
export class AICallObserverRegistry {
  private readonly observers: AICallObserver[] = [];

  register(observer: AICallObserver): void {
    this.observers.push(observer);
  }

  unregister(observer: AICallObserver): boolean {
    const idx = this.observers.indexOf(observer);
    if (idx === -1) return false;
    this.observers.splice(idx, 1);
    return true;
  }

  getAll(): readonly AICallObserver[] {
    return this.observers;
  }

  clear(): void {
    this.observers.length = 0;
  }

  get count(): number {
    return this.observers.length;
  }
}
