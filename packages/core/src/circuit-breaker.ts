/**
 * 断路器 — 对标 Claude Code withRetry.ts 中的 529 连续失败计数 + 模型降级机制
 *
 * 三态状态机:
 * - CLOSED: 正常通行，失败计数，达到阈值后转 OPEN
 * - OPEN: 所有请求立即失败 (fast-fail)，超时后转 HALF_OPEN
 * - HALF_OPEN: 放行有限请求进行探测，成功则 CLOSED，失败则 OPEN
 *
 * 用法:
 * ```ts
 * const breaker = new CircuitBreaker({ failureThreshold: 5, resetTimeoutMs: 30000 });
 *
 * try {
 *   const result = await breaker.execute(() => callExternalService());
 * } catch (e) {
 *   if (e instanceof CircuitOpenError) {
 *     // 使用降级逻辑
 *   }
 * }
 * ```
 */

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
  /** 连续失败多少次后打开断路器（默认 5） */
  failureThreshold?: number;
  /** 断路器打开后多久进入半开状态探测（毫秒，默认 30000） */
  resetTimeoutMs?: number;
  /** 半开状态最多允许几个请求通过探测（默认 2） */
  halfOpenMax?: number;
  /** 断路器名称（用于日志） */
  name?: string;
  /** 状态变化回调 */
  onStateChange?: (from: CircuitState, to: CircuitState) => void;
}

export class CircuitOpenError extends Error {
  constructor(
    public readonly circuitName: string,
    public readonly retryAfterMs: number,
  ) {
    super(`Circuit breaker "${circuitName}" is OPEN. Retry after ${retryAfterMs}ms.`);
    this.name = 'CircuitOpenError';
  }
}

export class CircuitBreaker {
  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly halfOpenMax: number;
  private readonly name: string;
  private readonly onStateChange?: (from: CircuitState, to: CircuitState) => void;

  private state: CircuitState = 'CLOSED';
  private failureCount = 0;
  private lastFailureTime = 0;
  private halfOpenAttempts = 0;

  // 统计信息
  private totalCalls = 0;
  private totalFailures = 0;
  private totalRejected = 0;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.resetTimeoutMs = options.resetTimeoutMs ?? 30_000;
    this.halfOpenMax = options.halfOpenMax ?? 2;
    this.name = options.name ?? 'default';
    this.onStateChange = options.onStateChange;
  }

  /**
   * 通过断路器执行操作
   * @throws CircuitOpenError 当断路器处于 OPEN 状态
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    this.totalCalls++;

    if (this.state === 'OPEN') {
      // 检查是否该进入 HALF_OPEN
      const elapsed = Date.now() - this.lastFailureTime;
      if (elapsed >= this.resetTimeoutMs) {
        this.transition('HALF_OPEN');
      } else {
        this.totalRejected++;
        throw new CircuitOpenError(this.name, this.resetTimeoutMs - elapsed);
      }
    }

    if (this.state === 'HALF_OPEN' && this.halfOpenAttempts >= this.halfOpenMax) {
      this.totalRejected++;
      throw new CircuitOpenError(this.name, this.resetTimeoutMs);
    }

    if (this.state === 'HALF_OPEN') {
      this.halfOpenAttempts++;
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  /**
   * 同步版本（适用于不需要 async 的场景）
   */
  executeSync<T>(fn: () => T): T {
    this.totalCalls++;

    if (this.state === 'OPEN') {
      const elapsed = Date.now() - this.lastFailureTime;
      if (elapsed >= this.resetTimeoutMs) {
        this.transition('HALF_OPEN');
      } else {
        this.totalRejected++;
        throw new CircuitOpenError(this.name, this.resetTimeoutMs - elapsed);
      }
    }

    if (this.state === 'HALF_OPEN' && this.halfOpenAttempts >= this.halfOpenMax) {
      this.totalRejected++;
      throw new CircuitOpenError(this.name, this.resetTimeoutMs);
    }

    if (this.state === 'HALF_OPEN') {
      this.halfOpenAttempts++;
    }

    try {
      const result = fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess(): void {
    if (this.state === 'HALF_OPEN') {
      this.transition('CLOSED');
    }
    this.failureCount = 0;
  }

  private onFailure(): void {
    this.totalFailures++;
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.state === 'HALF_OPEN') {
      this.transition('OPEN');
      return;
    }

    if (this.state === 'CLOSED' && this.failureCount >= this.failureThreshold) {
      this.transition('OPEN');
    }
  }

  private transition(to: CircuitState): void {
    const from = this.state;
    if (from === to) return;

    this.state = to;
    // Log state transition (no NestJS dependency in @zucker/core)

    if (to === 'CLOSED') {
      this.failureCount = 0;
      this.halfOpenAttempts = 0;
    }
    if (to === 'HALF_OPEN') {
      this.halfOpenAttempts = 0;
    }

    this.onStateChange?.(from, to);
  }

  /** 获取当前状态 */
  getState(): CircuitState {
    // 检查是否需要自动转换 OPEN → HALF_OPEN
    if (this.state === 'OPEN') {
      const elapsed = Date.now() - this.lastFailureTime;
      if (elapsed >= this.resetTimeoutMs) {
        this.transition('HALF_OPEN');
      }
    }
    return this.state;
  }

  /** 获取统计信息 */
  getStats() {
    return {
      name: this.name,
      state: this.getState(),
      failureCount: this.failureCount,
      totalCalls: this.totalCalls,
      totalFailures: this.totalFailures,
      totalRejected: this.totalRejected,
    };
  }

  /** 手动重置断路器 */
  reset(): void {
    this.transition('CLOSED');
    this.totalCalls = 0;
    this.totalFailures = 0;
    this.totalRejected = 0;
  }
}
