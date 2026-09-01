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
        cleaned++;
      }
    }
    return cleaned;
  }

  private async executeTask<T>(id: string, definition: TaskDefinition<T>): Promise<void> {
    const info = this.tasks.get(id) as TaskInfo<T>;
    const maxRetries = definition.maxRetries ?? 0;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (this.cancelledTasks.has(id)) return;

      info.status = 'running';
      info.startedAt = Date.now();
      info.attempts = attempt + 1;

      const ctx: TaskContext = {
        taskId: id,
        updateProgress: (progress, message) => {
          info.progress = Math.max(0, Math.min(1, progress));
          info.progressMessage = message;
        },
        isCancelled: () => this.cancelledTasks.has(id),
      };

      try {
        const resultPromise = definition.handler(ctx);

        // 超时控制
        let result: T;
        if (definition.timeoutMs) {
          result = await Promise.race([
            resultPromise,
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error(`Task timeout after ${definition.timeoutMs}ms`)), definition.timeoutMs),
            ),
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

        if (attempt < maxRetries) {
          this.logger.warn(`Task "${info.name}" attempt ${attempt + 1} failed: ${errorMsg}. Retrying...`);
          // 指数退避
          await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
          continue;
        }

        info.status = 'failed';
        info.error = errorMsg;
        info.completedAt = Date.now();

        // 放入死信队列
        if (this.deadLetterQueue.length >= this.maxDlqSize) {
          this.deadLetterQueue.shift();
        }
        this.deadLetterQueue.push({ ...info });

        this.logger.error(`Task "${info.name}" failed after ${info.attempts} attempts: ${errorMsg}`);
      }
    }
  }
}
