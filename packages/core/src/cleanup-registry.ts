/**
 * 清理注册表 — 对标 Claude Code cleanupRegistry.ts
 *
 * 全局的清理函数注册中心。各模块自行注册清理逻辑，
 * 停机时并行执行所有已注册的清理函数。
 *
 * 与 GracefulShutdownManager 的区别：
 * - CleanupRegistry 是模块级自注册（无阶段概念，简单并行）
 * - GracefulShutdownManager 是应用级编排（有阶段顺序）
 *
 * 两者可组合使用：CleanupRegistry 作为 GracefulShutdownManager 的某个阶段。
 *
 * 用法:
 * ```ts
 * // 模块内自注册
 * const unregister = CleanupRegistry.register(async () => {
 *   await watcher.close();
 * });
 *
 * // 停机时
 * await CleanupRegistry.runAll(); // 并行执行所有清理函数
 * ```
 */
export class CleanupRegistry {
  private static readonly fns = new Set<() => Promise<void>>();

  /**
   * 注册清理函数
   * @returns 取消注册函数
   */
  static register(fn: () => Promise<void>): () => void {
    CleanupRegistry.fns.add(fn);
    return () => {
      CleanupRegistry.fns.delete(fn);
    };
  }

  /**
   * 执行所有清理函数（并行）
   */
  static async runAll(): Promise<{ total: number; failed: number }> {
    const fns = [...CleanupRegistry.fns];
    const results = await Promise.allSettled(fns.map((fn) => fn()));
    const failed = results.filter((r) => r.status === 'rejected').length;
    CleanupRegistry.fns.clear();
    return { total: fns.length, failed };
  }

  /** 已注册的清理函数数量 */
  static get size(): number {
    return CleanupRegistry.fns.size;
  }

  /** 清除所有注册（不执行） */
  static clear(): void {
    CleanupRegistry.fns.clear();
  }
}
