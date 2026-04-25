import { Injectable, OnModuleDestroy, Logger } from '@nestjs/common';

/**
 * 优雅停机编排器 — 对标 Claude Code gracefulShutdown.ts
 *
 * 按阶段（phase）顺序执行停机回调，确保资源按正确顺序释放。
 *
 * 阶段约定:
 * - 0: 停止接受新请求（关闭 HTTP 监听、暂停队列消费）
 * - 1: 等待进行中的工作完成（drain 队列、完成活跃请求）
 * - 2: 刷新缓冲区（flush 日志、flush 指标）
 * - 3: 关闭连接（断开数据库、Redis、MQ）
 * - 9: 最终清理（临时文件、进程锁）
 *
 * 用法:
 * ```ts
 * @Injectable()
 * class QueueService {
 *   constructor(private shutdown: GracefulShutdownManager) {
 *     shutdown.register(0, () => this.queue.pause(), 'pause-queue');
 *     shutdown.register(1, () => this.queue.drain(), 'drain-queue');
 *   }
 * }
 * ```
 */
export interface ShutdownCallback {
  fn: () => Promise<void> | void;
  name: string;
  timeoutMs: number;
}

@Injectable()
export class GracefulShutdownManager implements OnModuleDestroy {
  private readonly logger = new Logger(GracefulShutdownManager.name);
  private readonly phases = new Map<number, ShutdownCallback[]>();

  /**
   * 注册停机回调
   * @param phase 阶段编号（越小越先执行）
   * @param fn 回调函数
   * @param name 回调名称（用于日志）
   * @param timeoutMs 单个回调超时时间（默认 10 秒）
   * @returns 取消注册函数
   */
  register(
    phase: number,
    fn: () => Promise<void> | void,
    name = 'anonymous',
    timeoutMs = 10_000,
  ): () => void {
    const callback: ShutdownCallback = { fn, name, timeoutMs };

    if (!this.phases.has(phase)) {
      this.phases.set(phase, []);
    }
    this.phases.get(phase)!.push(callback);

    return () => {
      const callbacks = this.phases.get(phase);
      if (callbacks) {
        const idx = callbacks.indexOf(callback);
        if (idx !== -1) callbacks.splice(idx, 1);
      }
    };
  }

  async onModuleDestroy(): Promise<void> {
    const sorted = [...this.phases.entries()].sort((a, b) => a[0] - b[0]);
    const totalCallbacks = sorted.reduce((sum, [, cbs]) => sum + cbs.length, 0);

    this.logger.log(`Graceful shutdown started (${totalCallbacks} callbacks in ${sorted.length} phases)`);

    for (const [phase, callbacks] of sorted) {
      this.logger.log(`Phase ${phase}: ${callbacks.length} callback(s)`);

      const results = await Promise.allSettled(
        callbacks.map(async (cb) => {
          const start = Date.now();
          try {
            await Promise.race([
              Promise.resolve(cb.fn()),
              new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error(`Timeout after ${cb.timeoutMs}ms`)), cb.timeoutMs),
              ),
            ]);
            this.logger.log(`  [OK] ${cb.name} (${Date.now() - start}ms)`);
          } catch (error) {
            this.logger.warn(
              `  [FAIL] ${cb.name} (${Date.now() - start}ms): ${error instanceof Error ? error.message : error}`,
            );
            throw error;
          }
        }),
      );

      const failed = results.filter((r) => r.status === 'rejected').length;
      if (failed > 0) {
        this.logger.warn(`Phase ${phase}: ${failed}/${callbacks.length} failed`);
      }
    }

    this.logger.log('Graceful shutdown completed');
  }

  /** 获取注册的回调统计 */
  getStats(): { phase: number; count: number; names: string[] }[] {
    return [...this.phases.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([phase, callbacks]) => ({
        phase,
        count: callbacks.length,
        names: callbacks.map((c) => c.name),
      }));
  }
}
