import { Logger } from '@nestjs/common';

/**
 * 后台任务生命周期管理 — 对标 Claude Code Task.ts 状态机
 *
 * 管理后台任务的完整生命周期: pending → running → completed/failed/killed
 * 支持进度追踪、超时控制、死信队列。
 *
 * 用法:
 * ```ts
 * const manager = new TaskLifecycleManager();
 *
 * const taskId = manager.submit({
 *   name: 'export-csv',
 *   handler: async (ctx) => {
 *     ctx.updateProgress(0, 'Starting...');
 *     for (const batch of batches) {
 *       await process(batch);
 *       ctx.updateProgress(++done / total);
 *     }
 *     return { file: outputPath };
 *   },
 *   timeoutMs: 60_000,
 *   maxRetries: 2,
 * });
 *
 * const status = manager.getTask(taskId);
 * ```
 */

export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'killed';

export interface TaskContext {
  /** 更新任务进度 (0~1) */
  updateProgress(progress: number, message?: string): void;
  /** 检查任务是否被取消 */
  isCancelled(): boolean;
  /** 任务被取消（kill）或本次尝试超时时触发 abort；长任务应监听并尽快停止 */
  readonly signal: AbortSignal;
  /** 任务 ID */
  readonly taskId: string;
}

export interface TaskDefinition<T = unknown> {
  name: string;
  handler: (ctx: TaskContext) => Promise<T>;
  timeoutMs?: number;
  maxRetries?: number;
  metadata?: Record<string, unknown>;
}

export interface TaskInfo<T = unknown> {
  id: string;
  name: string;
  status: TaskStatus;
  progress: number;
  progressMessage?: string;
  result?: T;
  error?: string;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  attempts: number;
  metadata?: Record<string, unknown>;
}

let taskIdCounter = 0;
function generateTaskId(): string {
  return `task_${Date.now()}_${++taskIdCounter}`;
}

export class TaskLifecycleManager {
  private readonly logger = new Logger(TaskLifecycleManager.name);
  private readonly tasks = new Map<string, TaskInfo>();
  private readonly cancelledTasks = new Set<string>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly deadLetterQueue: TaskInfo[] = [];
  private readonly maxDlqSize: number;

  constructor(options?: { maxDlqSize?: number }) {
    this.maxDlqSize = options?.maxDlqSize ?? 100;
  }

  /**
   * 提交任务并异步执行
   */
  submit<T>(definition: TaskDefinition<T>): string {
    const id = generateTaskId();
    const info: TaskInfo<T> = {
      id,
      name: definition.name,
      status: 'pending',
      progress: 0,
      createdAt: Date.now(),
      attempts: 0,
      metadata: definition.metadata,
    };

    this.tasks.set(id, info);
    this.executeTask(id, definition);
    return id;
  }

  /**
   * 获取任务状态
   */
  getTask(id: string): TaskInfo | undefined {
    return this.tasks.get(id);
  }

  /**
   * 列出所有任务
   */
  listTasks(filter?: { status?: TaskStatus }): TaskInfo[] {
    const tasks = [...this.tasks.values()];
    if (filter?.status) {
      return tasks.filter((t) => t.status === filter.status);
    }
    return tasks;
  }

  /**
   * 取消任务
   */
  kill(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task || task.status === 'completed' || task.status === 'failed' || task.status === 'killed') {
      return false;
    }
    this.cancelledTasks.add(id);
    this.controllers.get(id)?.abort(new Error('Task killed'));
    task.status = 'killed';
    task.completedAt = Date.now();
    return true;
  }

  /**
   * 获取死信队列中的失败任务
   */
  getDeadLetterQueue(): TaskInfo[] {
    return [...this.deadLetterQueue];
  }

  /**
   * 清理已完成的任务（释放内存）
   */
  cleanup(olderThanMs = 3600_000): number {
    const cutoff = Date.now() - olderThanMs;
    let cleaned = 0;
    for (const [id, task] of this.tasks) {
      if (
        (task.status === 'completed' || task.status === 'failed' || task.status === 'killed') &&
        (task.completedAt ?? task.createdAt) < cutoff
      ) {
        this.tasks.delete(id);
        this.cancelledTasks.delete(id);
        cleaned++;
      }
    }
    return cleaned;
  }

  private async executeTask<T>(id: string, definition: TaskDefinition<T>): Promise<void> {
    const info = this.tasks.get(id) as TaskInfo<T>;
    const maxRetries = definition.maxRetries ?? 0;

    try {
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (this.cancelledTasks.has(id)) return;

        const controller = new AbortController();
        this.controllers.set(id, controller);

        info.status = 'running';
        info.startedAt = Date.now();
        info.attempts = attempt + 1;

        const ctx: TaskContext = {
          taskId: id,
          signal: controller.signal,
          updateProgress: (progress, message) => {
            info.progress = Math.max(0, Math.min(1, progress));
            info.progressMessage = message;
          },
          isCancelled: () => this.cancelledTasks.has(id) || controller.signal.aborted,
        };

        let settled = false;
        let resultPromise: Promise<T> | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let timedOut = false;
        try {
          resultPromise = Promise.resolve().then(() => definition.handler(ctx));
          resultPromise.then(
            () => { settled = true; },
            () => { settled = true; },
          );

          // 超时控制：超时后中止本次尝试并清理计时器
          let result: T;
          if (definition.timeoutMs) {
            result = await Promise.race([
              resultPromise,
              new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                  timedOut = true;
                  reject(new Error(`Task timeout after ${definition.timeoutMs}ms`));
                }, definition.timeoutMs);
                timer.unref?.();
              }),
            ]);
          } else {
            result = await resultPromise;
          }

          if (this.cancelledTasks.has(id)) return;

          info.status = 'completed';
          info.progress = 1;
          info.result = result;
          info.completedAt = Date.now();
          return;
        } catch (error) {
          if (this.cancelledTasks.has(id)) return;

          const errorMsg = error instanceof Error ? error.message : String(error);
          let abandoned = false;

          if (timedOut) {
            controller.abort(error);
            // 不让重试与仍在运行的上一次尝试重叠：等待其在宽限期内结束，否则视为放弃且不再重试
            if (!settled && resultPromise) {
              const graceMs = Math.min(definition.timeoutMs ?? 0, 5_000);
              let graceTimer: ReturnType<typeof setTimeout> | undefined;
              await Promise.race([
                resultPromise.then(() => undefined, () => undefined),
                new Promise<void>((r) => {
                  graceTimer = setTimeout(r, graceMs);
                  graceTimer.unref?.();
                }),
              ]);
              if (graceTimer) clearTimeout(graceTimer);
              abandoned = !settled;
            }
          }

          if (attempt < maxRetries && !abandoned) {
            this.logger.warn(`Task "${info.name}" attempt ${attempt + 1} failed: ${errorMsg}. Retrying...`);
            // 指数退避
            await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
            continue;
          }

          info.status = 'failed';
          info.error = abandoned
            ? `${errorMsg} (handler did not stop after abort; not retried to avoid overlapping attempts)`
            : errorMsg;
          info.completedAt = Date.now();

          // 放入死信队列
          if (this.deadLetterQueue.length >= this.maxDlqSize) {
            this.deadLetterQueue.shift();
          }
          this.deadLetterQueue.push({ ...info });

          this.logger.error(`Task "${info.name}" failed after ${info.attempts} attempts: ${info.error}`);
          return;
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
    } finally {
      this.controllers.delete(id);
    }
  }
}
