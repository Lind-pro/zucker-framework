import type { TaskErrorSummary, TaskRepository } from './task-repository';

export interface TaskLeaseReconcilerOptions {
  batchSize?: number;
  retryDelayMs?: number;
  now?: () => Date;
}

export interface TaskLeaseReconcileResult {
  found: number;
  requeued: number;
  failed: number;
  conflicts: number;
}

const leaseExpiredError: TaskErrorSummary = {
  code: 'WORKER_LEASE_EXPIRED',
  category: 'INTERNAL',
  summary: 'Worker heartbeat expired before the task reached a terminal state',
  retryable: true,
};

export class TaskLeaseReconciler<TPayload = unknown, TResult = unknown> {
  private readonly batchSize: number;
  private readonly retryDelayMs: number;
  private readonly now: () => Date;

  constructor(
    private readonly repository: TaskRepository<TPayload, TResult>,
    options: TaskLeaseReconcilerOptions = {},
  ) {
    this.batchSize = options.batchSize ?? 100;
    this.retryDelayMs = options.retryDelayMs ?? 0;
    this.now = options.now ?? (() => new Date());
    if (this.batchSize < 1) throw new RangeError('batchSize must be at least 1');
    if (this.retryDelayMs < 0) throw new RangeError('retryDelayMs cannot be negative');
  }

  async runOnce(): Promise<TaskLeaseReconcileResult> {
    const now = this.now();
    const expired = await this.repository.findExpiredLeases({ now, limit: this.batchSize });
    const result: TaskLeaseReconcileResult = {
      found: expired.length,
      requeued: 0,
      failed: 0,
      conflicts: 0,
    };

    for (const task of expired) {
      if (!task.leaseToken) {
        result.conflicts += 1;
        continue;
      }
      const recovered = await this.repository.recoverExpiredLease({
        id: task.id,
        leaseToken: task.leaseToken,
        now,
        availableAt: new Date(now.getTime() + this.retryDelayMs),
        error: leaseExpiredError,
      });
      if (!recovered) result.conflicts += 1;
      else if (recovered.status === 'FAILED') result.failed += 1;
      else result.requeued += 1;
    }
    return result;
  }
}
