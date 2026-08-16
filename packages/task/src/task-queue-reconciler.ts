import type { TaskRecord, TaskRepository } from './task-repository';

export interface TaskQueueReconcilerOptions {
  batchSize?: number;
  now?: () => Date;
}

export interface TaskQueueReconcileResult {
  found: number;
  ensured: number;
  failed: number;
}

export interface ReadyTaskPublisher<TPayload = unknown, TResult = unknown> {
  ensure(task: TaskRecord<TPayload, TResult>): Promise<void>;
}

/**
 * Repairs drift between the durable task store and an at-least-once queue.
 * A publish failure leaves the task QUEUED so a later pass can retry safely.
 */
export class TaskQueueReconciler<TPayload = unknown, TResult = unknown> {
  private readonly batchSize: number;
  private readonly now: () => Date;
  private offset = 0;

  constructor(
    private readonly repository: TaskRepository<TPayload, TResult>,
    private readonly publisher: ReadyTaskPublisher<TPayload, TResult>,
    options: TaskQueueReconcilerOptions = {},
  ) {
    this.batchSize = options.batchSize ?? 100;
    this.now = options.now ?? (() => new Date());
    if (this.batchSize < 1) throw new RangeError('batchSize must be at least 1');
  }

  async runOnce(): Promise<TaskQueueReconcileResult> {
    let tasks = await this.repository.findReadyQueued({
      now: this.now(),
      limit: this.batchSize,
      offset: this.offset,
    });
    if (tasks.length === 0 && this.offset > 0) {
      this.offset = 0;
      tasks = await this.repository.findReadyQueued({
        now: this.now(),
        limit: this.batchSize,
        offset: 0,
      });
    }
    this.offset = tasks.length < this.batchSize ? 0 : this.offset + tasks.length;
    const result: TaskQueueReconcileResult = {
      found: tasks.length,
      ensured: 0,
      failed: 0,
    };

    for (const task of tasks) {
      try {
        await this.publisher.ensure(task);
        result.ensured += 1;
      } catch {
        result.failed += 1;
      }
    }
    return result;
  }
}
