import type { TaskOutboxRepository, TaskQueuePublisher } from './task-outbox';

export interface TaskOutboxDispatcherOptions {
  workerId: string;
  createLeaseToken: () => string;
  batchSize?: number;
  leaseDurationMs?: number;
  retryDelayMs?: (attempt: number) => number;
  now?: () => Date;
}

export interface TaskOutboxDispatchResult {
  claimed: number;
  published: number;
  rescheduled: number;
  conflicts: number;
}

export class TaskOutboxDispatcher<TPayload = unknown> {
  private readonly batchSize: number;
  private readonly leaseDurationMs: number;
  private readonly retryDelayMs: (attempt: number) => number;
  private readonly now: () => Date;

  constructor(
    private readonly repository: TaskOutboxRepository<TPayload>,
    private readonly publisher: TaskQueuePublisher<TPayload>,
    private readonly options: TaskOutboxDispatcherOptions,
  ) {
    this.batchSize = options.batchSize ?? 100;
    this.leaseDurationMs = options.leaseDurationMs ?? 30_000;
    this.retryDelayMs =
      options.retryDelayMs ?? ((attempt) => Math.min(60_000, 1_000 * 2 ** (attempt - 1)));
    this.now = options.now ?? (() => new Date());
    if (!options.workerId) throw new Error('workerId is required');
    if (this.batchSize < 1) throw new RangeError('batchSize must be at least 1');
    if (this.leaseDurationMs < 1) throw new RangeError('leaseDurationMs must be at least 1');
  }

  async runOnce(): Promise<TaskOutboxDispatchResult> {
    const claimedAt = this.now();
    const leaseToken = this.options.createLeaseToken();
    const messages = await this.repository.claimBatch({
      workerId: this.options.workerId,
      leaseToken,
      leaseExpiresAt: new Date(claimedAt.getTime() + this.leaseDurationMs),
      limit: this.batchSize,
      now: claimedAt,
    });
    const result: TaskOutboxDispatchResult = {
      claimed: messages.length,
      published: 0,
      rescheduled: 0,
      conflicts: 0,
    };

    for (const message of messages) {
      try {
        await this.publisher.publish(message);
        const marked = await this.repository.markPublished(message.id, leaseToken, this.now());
        if (marked) result.published += 1;
        else result.conflicts += 1;
      } catch (error) {
        const now = this.now();
        const delayMs = Math.max(0, this.retryDelayMs(message.attempt));
        const summary = error instanceof Error ? error.message : String(error);
        const rescheduled = await this.repository.reschedule(
          message.id,
          leaseToken,
          new Date(now.getTime() + delayMs),
          summary.slice(0, 280),
          now,
        );
        if (rescheduled) result.rescheduled += 1;
        else result.conflicts += 1;
      }
    }
    return result;
  }
}
