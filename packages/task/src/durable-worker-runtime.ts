import { randomUUID } from 'node:crypto';

import { isTerminalTaskStatus, type TaskStatus } from './task-state-machine';
import type { TaskErrorSummary, TaskRecord, TaskRepository } from './task-repository';
import type { TaskRetryPolicy } from './retry-policy';

export interface DurableTaskAttemptContext<TPayload = unknown, TResult = unknown> {
  readonly task: TaskRecord<TPayload, TResult>;
  readonly leaseToken: string;
  readonly signal: AbortSignal;
  now(): Date;
  assertActive(): Promise<void>;
  reportProgress(
    stage: string | undefined,
    progress: number,
  ): Promise<TaskRecord<TPayload, TResult>>;
}

export interface DurableTaskHandler<TPayload = unknown, TResult = unknown> {
  execute(context: DurableTaskAttemptContext<TPayload, TResult>): Promise<TResult>;
  /**
   * Override when task completion and a business projection must commit atomically.
   * Returning false means the current lease no longer owns the commit.
   */
  complete?(
    context: DurableTaskAttemptContext<TPayload, TResult>,
    result: TResult,
  ): Promise<boolean>;
  /** Override when retry state and a business projection must commit atomically. */
  retry?(
    context: DurableTaskAttemptContext<TPayload, TResult>,
    error: TaskErrorSummary,
    retryAt: Date,
  ): Promise<boolean>;
  /** Override when failure state and a business projection must commit atomically. */
  fail?(
    context: DurableTaskAttemptContext<TPayload, TResult>,
    error: TaskErrorSummary,
  ): Promise<boolean>;
  onCancelled?(context: DurableTaskAttemptContext<TPayload, TResult>): Promise<void> | void;
  cleanup?(context: DurableTaskAttemptContext<TPayload, TResult>): Promise<void> | void;
}

export interface DurableWorkerRuntimeLogger {
  debug?(message: string, context: Readonly<Record<string, unknown>>): void;
  warn?(message: string, context: Readonly<Record<string, unknown>>): void;
  error?(message: string, context: Readonly<Record<string, unknown>>): void;
}

export interface DurableWorkerHeartbeatScheduler {
  start(tick: () => Promise<void>, intervalMs: number): unknown;
  stop(handle: unknown): void;
}

export interface DurableWorkerRuntimeOptions<TPayload = unknown, TResult = unknown> {
  repository: TaskRepository<TPayload, TResult>;
  resolveHandler(
    task: TaskRecord<TPayload, TResult>,
  ): DurableTaskHandler<TPayload, TResult> | null | undefined;
  retryPolicy: TaskRetryPolicy;
  classifyError(error: unknown, task: TaskRecord<TPayload, TResult>): TaskErrorSummary;
  workerId: string;
  leaseDurationMs?: number;
  heartbeatIntervalMs?: number;
  maxConsecutiveHeartbeatFailures?: number;
  now?: () => Date;
  createLeaseToken?: () => string;
  retryAfterMs?(error: unknown, task: TaskRecord<TPayload, TResult>): number | undefined;
  heartbeatScheduler?: DurableWorkerHeartbeatScheduler;
  logger?: DurableWorkerRuntimeLogger;
  onAbort?(
    task: TaskRecord<TPayload, TResult>,
    reason: DurableTaskLeaseLostError,
  ): Promise<void> | void;
}

export interface DurableWorkerRunResult {
  taskId: string;
  kind: string;
  status: TaskStatus;
}

export interface DurableWorkerRunOptions {
  /** Host interruption stops this attempt; durable recovery waits for its abandoned lease. */
  signal?: AbortSignal;
}

export class DurableTaskAbortedError extends Error {
  constructor(readonly taskId: string) {
    super(`Durable task attempt was interrupted by its host: ${taskId}`);
    this.name = 'DurableTaskAbortedError';
  }
}

export class DurableTaskNotFoundError extends Error {
  constructor(readonly taskId: string) {
    super(`Durable task was not found: ${taskId}`);
    this.name = 'DurableTaskNotFoundError';
  }
}

export class UnsupportedDurableTaskKindError extends Error {
  constructor(
    readonly taskId: string,
    readonly kind: string,
  ) {
    super(`No durable task handler is registered for kind: ${kind}`);
    this.name = 'UnsupportedDurableTaskKindError';
  }
}

export class DurableTaskNotClaimableError extends Error {
  constructor(
    readonly taskId: string,
    readonly status: TaskStatus,
  ) {
    super(`Durable task is not claimable: ${taskId} (${status})`);
    this.name = 'DurableTaskNotClaimableError';
  }
}

export class DurableTaskLeaseLostError extends Error {
  constructor(
    readonly taskId: string,
    readonly operation: string,
  ) {
    super(`Durable task lease no longer owns ${operation}: ${taskId}`);
    this.name = 'DurableTaskLeaseLostError';
  }
}

export class DurableTaskRetryScheduledError extends Error {
  constructor(
    readonly taskId: string,
    readonly taskError: TaskErrorSummary,
    readonly retryAt: Date,
  ) {
    super(`Durable task retry was scheduled: ${taskId} (${taskError.code})`);
    this.name = 'DurableTaskRetryScheduledError';
  }
}

const defaultHeartbeatScheduler: DurableWorkerHeartbeatScheduler = {
  start(tick, intervalMs) {
    const handle = setInterval(() => void tick(), intervalMs);
    handle.unref?.();
    return handle;
  },
  stop(handle) {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
};

function terminalResult<TPayload, TResult>(
  task: TaskRecord<TPayload, TResult>,
): DurableWorkerRunResult {
  return { taskId: task.id, kind: task.kind, status: task.status };
}

export class DurableWorkerRuntime<TPayload = unknown, TResult = unknown> {
  private readonly repository: TaskRepository<TPayload, TResult>;
  private readonly retryPolicy: TaskRetryPolicy;
  private readonly workerId: string;
  private readonly leaseDurationMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly maxConsecutiveHeartbeatFailures: number;
  private readonly now: () => Date;
  private readonly createLeaseToken: () => string;
  private readonly heartbeatScheduler: DurableWorkerHeartbeatScheduler;

  constructor(private readonly options: DurableWorkerRuntimeOptions<TPayload, TResult>) {
    this.repository = options.repository;
    this.retryPolicy = options.retryPolicy;
    this.workerId = options.workerId;
    this.leaseDurationMs = options.leaseDurationMs ?? 90_000;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 20_000;
    this.maxConsecutiveHeartbeatFailures = options.maxConsecutiveHeartbeatFailures ?? 3;
    this.now = options.now ?? (() => new Date());
    this.createLeaseToken = options.createLeaseToken ?? randomUUID;
    this.heartbeatScheduler = options.heartbeatScheduler ?? defaultHeartbeatScheduler;

    if (!this.workerId.trim()) throw new RangeError('workerId cannot be empty');
    if (this.leaseDurationMs < 1) throw new RangeError('leaseDurationMs must be positive');
    if (this.heartbeatIntervalMs < 1) {
      throw new RangeError('heartbeatIntervalMs must be positive');
    }
    if (this.heartbeatIntervalMs >= this.leaseDurationMs) {
      throw new RangeError('heartbeatIntervalMs must be lower than leaseDurationMs');
    }
    if (this.maxConsecutiveHeartbeatFailures < 1) {
      throw new RangeError('maxConsecutiveHeartbeatFailures must be at least 1');
    }
  }

  async run(taskId: string, runOptions: DurableWorkerRunOptions = {}): Promise<DurableWorkerRunResult> {
    if (runOptions.signal?.aborted) throw new DurableTaskAbortedError(taskId);
    let task = await this.repository.findById(taskId);
    if (!task) throw new DurableTaskNotFoundError(taskId);
    if (isTerminalTaskStatus(task.status)) return terminalResult(task);

    if (task.status === 'RETRYING') {
      const queued = await this.repository.transition({
        id: task.id,
        from: 'RETRYING',
        to: 'QUEUED',
        now: this.now(),
      });
      if (!queued) {
        const latest = await this.repository.findById(task.id);
        if (latest && isTerminalTaskStatus(latest.status)) return terminalResult(latest);
        throw new DurableTaskNotClaimableError(task.id, latest?.status ?? task.status);
      }
      task = queued;
    }

    if (task.status !== 'QUEUED') {
      throw new DurableTaskNotClaimableError(task.id, task.status);
    }
    const handler = this.options.resolveHandler(task);
    if (!handler) throw new UnsupportedDurableTaskKindError(task.id, task.kind);

    const leaseToken = this.createLeaseToken();
    const claimedAt = this.now();
    if (runOptions.signal?.aborted) throw new DurableTaskAbortedError(taskId);
    const claimed = await this.repository.claim({
      id: task.id,
      workerId: this.workerId,
      leaseToken,
      leaseExpiresAt: this.leaseExpiry(claimedAt),
      now: claimedAt,
    });
    if (!claimed) throw new DurableTaskNotClaimableError(task.id, task.status);

    const controller = new AbortController();
    let abortNotified = false;
    let heartbeatFailures = 0;
    let heartbeatInFlight: Promise<void> | undefined;
    let heartbeatHandle: unknown;
    let heartbeatStarted = false;
    const stopHeartbeat = () => {
      if (!heartbeatStarted) return;
      heartbeatStarted = false;
      this.heartbeatScheduler.stop(heartbeatHandle);
    };
    const onHostAbort = () => {
      if (!controller.signal.aborted) controller.abort(new DurableTaskAbortedError(claimed.id));
      stopHeartbeat();
    };
    runOptions.signal?.addEventListener('abort', onHostAbort, { once: true });
    if (runOptions.signal?.aborted) onHostAbort();

    const abortAttempt = async (operation: string): Promise<void> => {
      if (controller.signal.aborted) return;
      const reason = new DurableTaskLeaseLostError(claimed.id, operation);
      controller.abort(reason);
      if (abortNotified) return;
      abortNotified = true;
      try {
        await this.options.onAbort?.(claimed, reason);
      } catch {
        this.options.logger?.warn?.('durable_task_abort_callback_failed', {
          taskId: claimed.id,
          kind: claimed.kind,
        });
      }
    };

    const renewLease = async (): Promise<boolean> => {
      const now = this.now();
      return this.repository.heartbeat({
        id: claimed.id,
        leaseToken,
        leaseExpiresAt: this.leaseExpiry(now),
        now,
      });
    };

    const heartbeat = (): Promise<void> => {
      if (heartbeatInFlight || controller.signal.aborted) return Promise.resolve();
      const renewal = (async () => {
        try {
          const renewed = await renewLease();
          if (!renewed) {
            this.options.logger?.error?.('durable_task_lease_lost', {
              taskId: claimed.id,
              kind: claimed.kind,
            });
            await abortAttempt('heartbeat');
            return;
          }
          heartbeatFailures = 0;
        } catch {
          heartbeatFailures += 1;
          this.options.logger?.warn?.('durable_task_heartbeat_failed', {
            taskId: claimed.id,
            kind: claimed.kind,
            consecutiveFailures: heartbeatFailures,
          });
          if (heartbeatFailures >= this.maxConsecutiveHeartbeatFailures) {
            await abortAttempt('heartbeat');
          }
        }
      })();
      heartbeatInFlight = renewal;
      return renewal.finally(() => { if (heartbeatInFlight === renewal) heartbeatInFlight = undefined; });
    };

    const context: DurableTaskAttemptContext<TPayload, TResult> = {
      task: claimed,
      leaseToken,
      signal: controller.signal,
      now: this.now,
      assertActive: async () => {
        if (controller.signal.aborted) throw controller.signal.reason;
        let active: boolean;
        try {
          active = await renewLease();
        } catch (error) {
          await abortAttempt('active check');
          throw error;
        }
        if (active) return;
        await abortAttempt('active check');
        throw new DurableTaskLeaseLostError(claimed.id, 'active check');
      },
      reportProgress: async (stage, progress) => {
        if (controller.signal.aborted) throw controller.signal.reason;
        const updated = await this.repository.reportProgress({
          id: claimed.id,
          leaseToken,
          stage,
          progress,
          now: this.now(),
        });
        if (updated) return updated;
        await abortAttempt('progress update');
        throw new DurableTaskLeaseLostError(claimed.id, 'progress update');
      },
    };

    try {
      if (!controller.signal.aborted) {
        heartbeatHandle = this.heartbeatScheduler.start(heartbeat, this.heartbeatIntervalMs);
        heartbeatStarted = true;
      }
      if (controller.signal.aborted) throw controller.signal.reason;
      const result = await handler.execute(context);
      if (controller.signal.aborted) {
        throw controller.signal.reason instanceof Error
          ? controller.signal.reason
          : new DurableTaskLeaseLostError(claimed.id, 'completion');
      }

      const completed = handler.complete
        ? await handler.complete(context, result)
        : Boolean(
            await this.repository.transition({
              id: claimed.id,
              from: 'PROCESSING',
              to: 'COMPLETED',
              leaseToken,
              result,
              now: this.now(),
            }),
          );
      if (!completed) return this.resolveRejectedCommit(claimed, 'completion');
      return { taskId: claimed.id, kind: claimed.kind, status: 'COMPLETED' };
    } catch (executionError) {
      const latest = await this.findLatestBestEffort(claimed);
      if (latest && isTerminalTaskStatus(latest.status)) {
        if (latest.status === 'CANCELLED') await handler.onCancelled?.(context);
        return terminalResult(latest);
      }
      if (executionError instanceof DurableTaskRetryScheduledError) throw executionError;
      if (controller.signal.aborted) {
        throw controller.signal.reason instanceof Error
          ? controller.signal.reason
          : new DurableTaskLeaseLostError(claimed.id, 'execution');
      }
      if (executionError instanceof DurableTaskLeaseLostError) throw executionError;

      const taskError = this.options.classifyError(executionError, claimed);
      const decision = this.retryPolicy.decide({
        error: taskError,
        attempt: claimed.attempt,
        maxAttempts: claimed.maxAttempts,
        retryAfterMs: this.options.retryAfterMs?.(executionError, claimed),
      });
      if (decision.retry) {
        const retryAt = new Date(this.now().getTime() + decision.delayMs);
        const retried = handler.retry
          ? await handler.retry(context, taskError, retryAt)
          : await this.retry(context, taskError, retryAt);
        if (!retried) return this.resolveRejectedCommit(claimed, 'retry');
        throw new DurableTaskRetryScheduledError(claimed.id, taskError, retryAt);
      }

      const failed = handler.fail
        ? await handler.fail(context, taskError)
        : Boolean(
            await this.repository.transition({
              id: claimed.id,
              from: 'PROCESSING',
              to: 'FAILED',
              leaseToken,
              error: taskError,
              now: this.now(),
            }),
          );
      if (!failed) return this.resolveRejectedCommit(claimed, 'failure');
      return { taskId: claimed.id, kind: claimed.kind, status: 'FAILED' };
    } finally {
      stopHeartbeat();
      runOptions.signal?.removeEventListener('abort', onHostAbort);
      await heartbeatInFlight?.catch(() => undefined);
      try {
        await handler.cleanup?.(context);
      } catch {
        this.options.logger?.warn?.('durable_task_cleanup_failed', {
          taskId: claimed.id,
          kind: claimed.kind,
        });
      }
    }
  }

  private leaseExpiry(now: Date): Date {
    return new Date(now.getTime() + this.leaseDurationMs);
  }

  private async retry(
    context: DurableTaskAttemptContext<TPayload, TResult>,
    error: TaskErrorSummary,
    retryAt: Date,
  ): Promise<boolean> {
    const retrying = await this.repository.transition({
      id: context.task.id,
      from: 'PROCESSING',
      to: 'RETRYING',
      leaseToken: context.leaseToken,
      error,
      availableAt: retryAt,
      now: this.now(),
    });
    if (!retrying) return false;
    return Boolean(
      await this.repository.transition({
        id: context.task.id,
        from: 'RETRYING',
        to: 'QUEUED',
        error,
        availableAt: retryAt,
        now: this.now(),
      }),
    );
  }

  private async resolveRejectedCommit(
    claimed: TaskRecord<TPayload, TResult>,
    operation: string,
  ): Promise<DurableWorkerRunResult> {
    const latest = await this.repository.findById(claimed.id);
    if (latest && isTerminalTaskStatus(latest.status)) return terminalResult(latest);
    throw new DurableTaskLeaseLostError(claimed.id, operation);
  }

  private async findLatestBestEffort(
    claimed: TaskRecord<TPayload, TResult>,
  ): Promise<TaskRecord<TPayload, TResult> | null> {
    try {
      return await this.repository.findById(claimed.id);
    } catch {
      this.options.logger?.warn?.('durable_task_status_refresh_failed', {
        taskId: claimed.id,
        kind: claimed.kind,
      });
      return null;
    }
  }
}
