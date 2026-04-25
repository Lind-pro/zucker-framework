import { Injectable, Logger } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * 请求级资源使用追踪
 *
 * 对标 Claude Code 的 cost-tracker.ts:
 * 每次请求自动追踪数据库查询次数、缓存命中率、存储操作等。
 *
 * 用法:
 * ```ts
 * // 在中间件中初始化
 * UsageTracker.runWithContext(async () => {
 *   // 在 service 中记录
 *   UsageTracker.track('db_query');
 *   UsageTracker.track('cache_hit');
 *
 *   // 请求结束时获取汇总
 *   const summary = UsageTracker.getSummary();
 *   // → { db_query: 5, cache_hit: 2, cache_miss: 1, elapsed: 123 }
 * });
 * ```
 */

export interface UsageMetrics {
  [key: string]: number;
}

export interface UsageSummary {
  /** 各项指标的计数 */
  metrics: UsageMetrics;
  /** 请求开始时间 */
  startTime: number;
  /** 已用时间（毫秒） */
  elapsed: number;
}

class UsageContext {
  readonly startTime = Date.now();
  private readonly counters = new Map<string, number>();

  increment(type: string, amount = 1): void {
    const current = this.counters.get(type) ?? 0;
    this.counters.set(type, current + amount);
  }

  get(type: string): number {
    return this.counters.get(type) ?? 0;
  }

  toSummary(): UsageSummary {
    const metrics: UsageMetrics = {};
    for (const [key, value] of this.counters) {
      metrics[key] = value;
    }
    return {
      metrics,
      startTime: this.startTime,
      elapsed: Date.now() - this.startTime,
    };
  }
}

const storage = new AsyncLocalStorage<UsageContext>();

/**
 * 轻量级请求级资源使用追踪器
 */
@Injectable()
export class UsageTracker {
  private static readonly logger = new Logger(UsageTracker.name);

  /**
   * 在新的追踪上下文中执行函数
   */
  static runWithContext<T>(fn: () => T): T {
    return storage.run(new UsageContext(), fn);
  }

  /**
   * 记录一次资源使用
   * @param type 资源类型（如 'db_query', 'cache_hit', 'cache_miss', 'storage_read', 'api_call'）
   * @param amount 使用量（默认 1）
   */
  static track(type: string, amount = 1): void {
    const ctx = storage.getStore();
    if (ctx) {
      ctx.increment(type, amount);
    }
  }

  /**
   * 获取指定类型的当前计数
   */
  static getCount(type: string): number {
    return storage.getStore()?.get(type) ?? 0;
  }

  /**
   * 获取当前请求的使用汇总
   */
  static getSummary(): UsageSummary | undefined {
    return storage.getStore()?.toSummary();
  }

  /**
   * 检查是否在追踪上下文中
   */
  static isTracking(): boolean {
    return storage.getStore() !== undefined;
  }

  // ─── 实例方法（通过 NestJS DI 注入） ──────────────────────────────

  track(type: string, amount = 1): void {
    UsageTracker.track(type, amount);
  }

  getSummary(): UsageSummary | undefined {
    return UsageTracker.getSummary();
  }
}
