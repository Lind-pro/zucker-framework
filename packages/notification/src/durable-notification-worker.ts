import {
  DEFAULT_NOTIFICATION_RETRY_POLICY,
  NotificationLeaseLostError,
  classifyNotificationDeliveryError,
  notificationRetryDelayMs,
  type NotificationDeliveryErrorClassifier,
  type NotificationDeliveryHandler,
  type NotificationDeliveryRepository,
  type NotificationRetryPolicy,
} from './durable-delivery';

export type NotificationWorkerOutcome =
  | { kind: 'idle' }
  | { kind: 'delivered'; deliveryId: string }
  | { kind: 'retry-scheduled'; deliveryId: string; availableAt: Date }
  | { kind: 'dead'; deliveryId: string; errorCode: string }
  | { kind: 'lost-lease'; deliveryId: string };

export interface DurableNotificationWorkerOptions {
  leaseMs: number;
  heartbeatMs?: number;
  retryPolicy?: NotificationRetryPolicy;
  classifyError?: NotificationDeliveryErrorClassifier;
  random?: () => number;
  clock?: () => Date;
}

/** Runs one durable attempt; process loops and concurrency stay application-owned. */
export class DurableNotificationWorker {
  private readonly classifyError: NotificationDeliveryErrorClassifier;
  private readonly retryPolicy: NotificationRetryPolicy;
  private readonly random: () => number;
  private readonly clock: () => Date;
  private readonly heartbeatMs: number;

  constructor(
    private readonly repository: NotificationDeliveryRepository,
    private readonly handler: NotificationDeliveryHandler,
    private readonly options: DurableNotificationWorkerOptions,
  ) {
    if (!Number.isFinite(options.leaseMs) || options.leaseMs <= 0) {
      throw new RangeError('leaseMs must be positive');
    }
    const heartbeatMs = options.heartbeatMs ?? Math.max(1, Math.floor(options.leaseMs / 3));
    if (
      !Number.isFinite(heartbeatMs) ||
      heartbeatMs <= 0 ||
      heartbeatMs >= options.leaseMs
    ) {
      throw new RangeError('heartbeatMs must be positive and less than leaseMs');
    }
    this.classifyError = options.classifyError ?? classifyNotificationDeliveryError;
    this.retryPolicy =
      options.retryPolicy ?? DEFAULT_NOTIFICATION_RETRY_POLICY;
    this.random = options.random ?? Math.random;
    this.clock = options.clock ?? (() => new Date());
    this.heartbeatMs = heartbeatMs;
  }

  async runOnce(input: {
    workerId: string;
    now?: Date;
    signal?: AbortSignal;
  }): Promise<NotificationWorkerOutcome> {
    const now = input.now ?? new Date();
    await this.repository.recoverExpiredLeases(now);
    const claim = await this.repository.claimNext({
      workerId: input.workerId,
      now,
      leaseMs: this.options.leaseMs,
    });
    if (!claim) return { kind: 'idle' };

    const heartbeat = this.startLeaseHeartbeat(
      claim.id,
      claim.leaseToken,
      input.signal,
    );

    try {
      const result = await this.handler.deliver({
        deliveryRef: claim.deliveryRef,
        channel: claim.channel,
        idempotencyKey: claim.idempotencyKey,
        attempt: claim.attempt,
        signal: heartbeat.signal,
      });
      await heartbeat.stop();
      const heartbeatFailure = heartbeat.failure();
      if (heartbeatFailure !== undefined) throw heartbeatFailure;
      await this.repository.markDelivered({
        id: claim.id,
        leaseToken: claim.leaseToken,
        providerMessageId: result.providerMessageId,
        now: this.clock(),
      });
      return { kind: 'delivered', deliveryId: claim.id };
    } catch (error) {
      const deliveryError = heartbeat.failure() ?? error;
      if (deliveryError instanceof NotificationLeaseLostError) {
        return { kind: 'lost-lease', deliveryId: claim.id };
      }
      const failure = input.signal?.aborted
        ? { code: 'NOTIFICATION_WORKER_ABORTED', retryable: true }
        : this.classifyError(deliveryError);
      const exhausted = claim.attempt >= claim.maxAttempts;

      try {
        const completedAt = this.clock();
        if (!failure.retryable || exhausted) {
          await this.repository.markDead({
            id: claim.id,
            leaseToken: claim.leaseToken,
            errorCode: failure.code,
            retryable: failure.retryable,
            now: completedAt,
          });
          return {
            kind: 'dead',
            deliveryId: claim.id,
            errorCode: failure.code,
          };
        }

        const explicitDelay = failure.retryAfterMs;
        const delay =
          explicitDelay !== undefined &&
          Number.isFinite(explicitDelay) &&
          explicitDelay >= 0
            ? explicitDelay
            : notificationRetryDelayMs(
                claim.attempt,
                this.retryPolicy,
                this.random,
              );
        const availableAt = new Date(completedAt.getTime() + delay);
        await this.repository.scheduleRetry({
          id: claim.id,
          leaseToken: claim.leaseToken,
          errorCode: failure.code,
          availableAt,
          now: completedAt,
        });
        return {
          kind: 'retry-scheduled',
          deliveryId: claim.id,
          availableAt,
        };
      } catch (commitError) {
        if (commitError instanceof NotificationLeaseLostError) {
          return { kind: 'lost-lease', deliveryId: claim.id };
        }
        throw commitError;
      }
    } finally {
      await heartbeat.stop();
    }
  }

  private startLeaseHeartbeat(
    id: string,
    leaseToken: string,
    parentSignal?: AbortSignal,
  ): {
    signal: AbortSignal;
    stop: () => Promise<void>;
    failure: () => unknown;
  } {
    const deliveryController = new AbortController();
    const heartbeatController = new AbortController();
    let heartbeatFailure: unknown;
    const onParentAbort = () => {
      deliveryController.abort(parentSignal?.reason);
      heartbeatController.abort(parentSignal?.reason);
    };
    if (parentSignal?.aborted) {
      onParentAbort();
    } else {
      parentSignal?.addEventListener('abort', onParentAbort, { once: true });
    }

    const completion = (async () => {
      while (
        await this.waitForHeartbeat(
          this.heartbeatMs,
          heartbeatController.signal,
        )
      ) {
        try {
          await this.repository.extendLease({
            id,
            leaseToken,
            now: this.clock(),
            leaseMs: this.options.leaseMs,
          });
        } catch (error) {
          heartbeatFailure = error;
          deliveryController.abort(error);
          return;
        }
      }
    })();

    let stopped = false;
    return {
      signal: deliveryController.signal,
      failure: () => heartbeatFailure,
      stop: async () => {
        if (!stopped) {
          stopped = true;
          heartbeatController.abort();
          parentSignal?.removeEventListener('abort', onParentAbort);
        }
        await completion;
      },
    };
  }

  private waitForHeartbeat(ms: number, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      const onAbort = () => {
        clearTimeout(timer);
        resolve(false);
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve(true);
      }, ms);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}
