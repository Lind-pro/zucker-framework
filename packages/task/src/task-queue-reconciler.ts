import type { ReadyTaskCursor, TaskRecord, TaskRepository } from './task-repository';

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
 *
 * Ready RETRYING rows (a worker stopped between RETRYING and QUEUED) are requeued here,
 * because no lease or other reconciler covers them. Pages use a keyset cursor so rows that
 * are claimed between passes do not shift later rows out of the scan.
 */
export class TaskQueueReconciler<TPayload = unknown, TResult = unknown> {
  private readonly batchSize: number;
  private readonly now: () => Date;
  private cursor: ReadyTaskCursor | undefined;

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
    const find = (after: ReadyTaskCursor | undefined) =>
      this.repository.findReadyQueued({
        now: this.now(),
        limit: this.batchSize,
        after,
        includeRetrying: true,
      });
    let tasks = await find(this.cursor);
    if (tasks.length === 0 && this.cursor) {
      this.cursor = undefined;
      tasks = await find(undefined);
    }
    const last = tasks.at(-1);
    this.cursor =
      tasks.length < this.batchSize || !last
        ? undefined
        : { availableAt: last.availableAt, createdAt: last.createdAt, id: last.id };
    const result: TaskQueueReconcileResult = {
      found: tasks.length,
      ensured: 0,
      failed: 0,
    };

    for (const candidate of tasks) {
      try {
        const task = candidate.status === 'RETRYING' ? await this.requeue(candidate) : candidate;
        if (!task) continue;
        await this.publisher.ensure(task);
        result.ensured += 1;
      } catch {
        result.failed += 1;
      }
    }
    return result;
  }

  private async requeue(
    task: TaskRecord<TPayload, TResult>,
  ): Promise<TaskRecord<TPayload, TResult> | null> {
    const queued = await this.repository.transition({
      id: task.id,
      from: 'RETRYING',
      to: 'QUEUED',
      error: task.error,
      now: this.now(),
    });
    if (queued) return queued;
    // Lost the race to the worker or a redelivery: publish whatever is queued now.
    const latest = await this.repository.findById(task.id);
    return latest?.status === 'QUEUED' ? latest : null;
  }
}
