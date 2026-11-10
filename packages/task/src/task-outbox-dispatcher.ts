import type { TaskOutboxRecord, TaskOutboxRepository, TaskQueuePublisher } from './task-outbox';

export interface TaskOutboxDispatcherLogger {
  warn?(message: string, context: Readonly<Record<string, unknown>>): void;
  error?(message: string, context: Readonly<Record<string, unknown>>): void;
}

export interface TaskOutboxDispatcherOptions<TPayload = unknown> {
  workerId: string;
  createLeaseToken: () => string;
  batchSize?: number;
  leaseDurationMs?: number;
  /**
   * The dispatcher stops publishing a claimed batch when less than this much lease time is
   * left; the remaining rows are reclaimed after the lease expires instead of being published
   * by a dispatcher that no longer owns them. Default: min(5s, leaseDurationMs / 3).
   */
  leaseSafetyMarginMs?: number;
  retryDelayMs?: (attempt: number) => number;
  /**
   * After this many failed publish attempts a message is parked: `onExhausted` is called and
   * it is rescheduled `exhaustedRetryDelayMs` later instead of on the normal backoff. The row
   * is never dropped (the outbox has no terminal failure state). Default: unlimited.
   */
  maxAttempts?: number;
  /** Delay used for parked messages. Default: 1 hour. */
  exhaustedRetryDelayMs?: number;
  onExhausted?(message: TaskOutboxRecord<TPayload>, error: unknown): Promise<void> | void;
  logger?: TaskOutboxDispatcherLogger;
  now?: () => Date;
}

export interface TaskOutboxDispatchResult {
  claimed: number;
  published: number;
  rescheduled: number;
  conflicts: number;
  /** Claimed messages left untouched because the batch lease was about to expire. */
  deferred: number;
  /**
   * Messages whose acknowledgement or reschedule threw, or whose publish did not finish before
   * the lease safety margin (left for lease expiry; the outcome of a timed-out publish is unknown,
   * so the message may be published again after reclaim — consumers must be idempotent).
   */
  errors: number;
  /** Messages that reached `maxAttempts` and were parked. */
  exhausted: number;
}

export class TaskOutboxDispatcher<TPayload = unknown> {
  private readonly batchSize: number;
  private readonly leaseDurationMs: number;
  private readonly leaseSafetyMarginMs: number;
  private readonly retryDelayMs: (attempt: number) => number;
  private readonly exhaustedRetryDelayMs: number;
  private readonly now: () => Date;

  constructor(
    private readonly repository: TaskOutboxRepository<TPayload>,
    private readonly publisher: TaskQueuePublisher<TPayload>,
    private readonly options: TaskOutboxDispatcherOptions<TPayload>,
  ) {
    this.batchSize = options.batchSize ?? 100;
    this.leaseDurationMs = options.leaseDurationMs ?? 30_000;
    this.leaseSafetyMarginMs =
      options.leaseSafetyMarginMs ?? Math.min(5_000, Math.floor(this.leaseDurationMs / 3));
    this.retryDelayMs =
      options.retryDelayMs ?? ((attempt) => Math.min(60_000, 1_000 * 2 ** (attempt - 1)));
    this.exhaustedRetryDelayMs = options.exhaustedRetryDelayMs ?? 3_600_000;
    this.now = options.now ?? (() => new Date());
    if (!options.workerId) throw new Error('workerId is required');
    if (this.batchSize < 1) throw new RangeError('batchSize must be at least 1');
    if (this.leaseDurationMs < 1) throw new RangeError('leaseDurationMs must be at least 1');
    if (this.leaseSafetyMarginMs < 0 || this.leaseSafetyMarginMs >= this.leaseDurationMs) {
      throw new RangeError('leaseSafetyMarginMs must be in [0, leaseDurationMs)');
    }
    if (options.maxAttempts !== undefined && !(options.maxAttempts >= 1)) {
      throw new RangeError('maxAttempts must be at least 1');
    }
  }

  async runOnce(): Promise<TaskOutboxDispatchResult> {
    const claimedAt = this.now();
    const leaseToken = this.options.createLeaseToken();
    const leaseExpiresAt = claimedAt.getTime() + this.leaseDurationMs;
    const messages = await this.repository.claimBatch({
      workerId: this.options.workerId,
      leaseToken,
      leaseExpiresAt: new Date(leaseExpiresAt),
      limit: this.batchSize,
      now: claimedAt,
    });
    const result: TaskOutboxDispatchResult = {
      claimed: messages.length,
      published: 0,
      rescheduled: 0,
      conflicts: 0,
      deferred: 0,
      errors: 0,
      exhausted: 0,
    };

    for (const [index, message] of messages.entries()) {
      // One lease covers the whole batch; never publish once it is (nearly) gone, or another
      // dispatcher may already have reclaimed the tail and publish it a second time.
      if (this.now().getTime() >= leaseExpiresAt - this.leaseSafetyMarginMs) {
        result.deferred = messages.length - index;
        this.options.logger?.warn?.('task_outbox_batch_lease_exhausted', {
          workerId: this.options.workerId,
          deferred: result.deferred,
        });
        break;
      }
      let publishError: unknown;
      let published = false;
      let timedOut = false;
      try {
        // A publish must not outlive the lease: race it against the remaining lease time.
        const budgetMs = leaseExpiresAt - this.leaseSafetyMarginMs - this.now().getTime();
        timedOut = (await withTimeout(this.publisher.publish(message), budgetMs)) === TIMED_OUT;
        published = !timedOut;
      } catch (error) {
        publishError = error;
      }
      if (timedOut) {
        result.errors += 1;
        result.deferred = messages.length - index - 1;
        this.options.logger?.warn?.('task_outbox_publish_timeout', {
          workerId: this.options.workerId,
          eventId: message.id,
          deferred: result.deferred,
        });
        break;
      }

      try {
        if (published) {
          const marked = await this.repository.markPublished(message.id, leaseToken, this.now());
          if (marked) result.published += 1;
          else result.conflicts += 1;
          continue;
        }
        const exhausted =
          this.options.maxAttempts !== undefined && message.attempt >= this.options.maxAttempts;
        if (exhausted) {
          result.exhausted += 1;
          await this.notifyExhausted(message, publishError);
        }
        const now = this.now();
        const delayMs = exhausted
          ? this.exhaustedRetryDelayMs
          : Math.max(0, this.retryDelayMs(message.attempt));
        const summary = publishError instanceof Error ? publishError.message : String(publishError);
        const rescheduled = await this.repository.reschedule(
          message.id,
          leaseToken,
          new Date(now.getTime() + delayMs),
          summary.slice(0, 280),
          now,
        );
        if (rescheduled) result.rescheduled += 1;
        else result.conflicts += 1;
      } catch {
        // A repository blip must not abort the batch; this row is retried after lease expiry.
        result.errors += 1;
        this.options.logger?.warn?.('task_outbox_commit_failed', {
          workerId: this.options.workerId,
          eventId: message.id,
        });
      }
    }
    return result;
  }

  private async notifyExhausted(
    message: TaskOutboxRecord<TPayload>,
    error: unknown,
  ): Promise<void> {
    this.options.logger?.error?.('task_outbox_attempts_exhausted', {
      eventId: message.id,
      taskId: message.taskId,
      attempt: message.attempt,
    });
    try {
      await this.options.onExhausted?.(message, error);
    } catch {
      this.options.logger?.warn?.('task_outbox_exhausted_callback_failed', { eventId: message.id });
    }
  }
}

const TIMED_OUT: unique symbol = Symbol('timed out');

/** Resolves with the promise's value, or `TIMED_OUT` after `ms`. The promise keeps running. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  if (ms <= 0) {
    promise.catch(() => undefined);
    return Promise.resolve(TIMED_OUT);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
    // A publish that fails after the timeout must not become an unhandled rejection.
    promise.catch(() => undefined);
  });
}
