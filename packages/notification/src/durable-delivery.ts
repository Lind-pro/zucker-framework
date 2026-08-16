import type { NotifyChannel } from './notifier.interface';

export type NotificationDeliveryStatus =
  | 'PENDING'
  | 'PROCESSING'
  | 'RETRYING'
  | 'DELIVERED'
  | 'DEAD';

/**
 * Durable delivery metadata deliberately excludes recipients and content.
 * Applications resolve the opaque deliveryRef inside their own data boundary.
 */
export interface NotificationDeliveryInput {
  id: string;
  idempotencyKey: string;
  idempotencyFingerprint: string;
  channel: NotifyChannel;
  deliveryRef: string;
  priority?: number;
  maxAttempts: number;
  availableAt?: Date;
  createdAt?: Date;
}

export interface NotificationDeliveryRecord {
  id: string;
  idempotencyKey: string;
  idempotencyFingerprint: string;
  channel: NotifyChannel;
  deliveryRef: string;
  priority: number;
  status: NotificationDeliveryStatus;
  attempt: number;
  maxAttempts: number;
  availableAt: Date;
  workerId?: string;
  leaseToken?: string;
  leaseExpiresAt?: Date;
  providerMessageId?: string;
  errorCode?: string;
  errorRetryable?: boolean;
  createdAt: Date;
  updatedAt: Date;
  deliveredAt?: Date;
  failedAt?: Date;
  version: number;
}

/**
 * Validates the storage-independent notification delivery contract.
 * Repository adapters should call this before persisting an enqueue request.
 */
export function validateNotificationDeliveryInput(
  input: NotificationDeliveryInput,
): void {
  if (
    !input.id ||
    !input.idempotencyKey ||
    !input.idempotencyFingerprint ||
    !input.deliveryRef
  ) {
    throw new RangeError('delivery identifiers must not be empty');
  }
  if (!Number.isInteger(input.maxAttempts) || input.maxAttempts < 1) {
    throw new RangeError('maxAttempts must be a positive integer');
  }
  if (input.priority !== undefined && !Number.isFinite(input.priority)) {
    throw new RangeError('priority must be finite');
  }
  if (
    (input.createdAt !== undefined &&
      !Number.isFinite(input.createdAt.getTime())) ||
    (input.availableAt !== undefined &&
      !Number.isFinite(input.availableAt.getTime()))
  ) {
    throw new RangeError('delivery dates must be valid');
  }
}

export interface NotificationDeliveryClaim extends NotificationDeliveryRecord {
  status: 'PROCESSING';
  workerId: string;
  leaseToken: string;
  leaseExpiresAt: Date;
}

export interface NotificationDeliveryRepository {
  /** Must atomically enforce idempotencyKey + idempotencyFingerprint. */
  enqueue(input: NotificationDeliveryInput): Promise<{
    delivery: NotificationDeliveryRecord;
    created: boolean;
  }>;

  /** Must atomically claim one due item and increment its attempt. */
  claimNext(input: {
    workerId: string;
    now: Date;
    leaseMs: number;
  }): Promise<NotificationDeliveryClaim | null>;

  /**
   * Requeue expired leases, or mark them dead when maxAttempts is exhausted.
   * Implementations must clear the old fencing token atomically.
   */
  recoverExpiredLeases(now: Date): Promise<{ retried: number; dead: number }>;

  /** Renews an active lease without changing the attempt count. */
  extendLease(input: {
    id: string;
    leaseToken: string;
    now: Date;
    leaseMs: number;
  }): Promise<NotificationDeliveryClaim>;

  markDelivered(input: {
    id: string;
    leaseToken: string;
    providerMessageId?: string;
    now: Date;
  }): Promise<NotificationDeliveryRecord>;

  scheduleRetry(input: {
    id: string;
    leaseToken: string;
    errorCode: string;
    availableAt: Date;
    now: Date;
  }): Promise<NotificationDeliveryRecord>;

  markDead(input: {
    id: string;
    leaseToken: string;
    errorCode: string;
    retryable: boolean;
    now: Date;
  }): Promise<NotificationDeliveryRecord>;

  getById(id: string): Promise<NotificationDeliveryRecord | null>;
}

export class NotificationIdempotencyConflictError extends Error {
  readonly code = 'NOTIFICATION_IDEMPOTENCY_CONFLICT';

  constructor(readonly idempotencyKey: string) {
    super(`Notification idempotency key was reused with different input: ${idempotencyKey}`);
    this.name = 'NotificationIdempotencyConflictError';
  }
}

export class NotificationLeaseLostError extends Error {
  readonly code = 'NOTIFICATION_LEASE_LOST';

  constructor(readonly deliveryId: string) {
    super(`Notification delivery lease is no longer valid: ${deliveryId}`);
    this.name = 'NotificationLeaseLostError';
  }
}

export class NotificationDeliveryError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'NotificationDeliveryError';
  }
}

export interface NotificationDeliveryFailure {
  code: string;
  retryable: boolean;
  retryAfterMs?: number;
}

export type NotificationDeliveryErrorClassifier = (
  error: unknown,
) => NotificationDeliveryFailure;

export function classifyNotificationDeliveryError(
  error: unknown,
): NotificationDeliveryFailure {
  if (error instanceof NotificationDeliveryError) {
    return {
      code: error.code,
      retryable: error.retryable,
      retryAfterMs: error.retryAfterMs,
    };
  }
  return {
    code: 'NOTIFICATION_DELIVERY_FAILED',
    retryable: true,
  };
}

export interface NotificationRetryPolicy {
  baseDelayMs: number;
  multiplier: number;
  maxDelayMs: number;
  jitterRatio: number;
}

export const DEFAULT_NOTIFICATION_RETRY_POLICY: NotificationRetryPolicy = {
  baseDelayMs: 1_000,
  multiplier: 2,
  maxDelayMs: 5 * 60_000,
  jitterRatio: 0.2,
};

export function notificationRetryDelayMs(
  attempt: number,
  policy: NotificationRetryPolicy = DEFAULT_NOTIFICATION_RETRY_POLICY,
  random: () => number = Math.random,
): number {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new RangeError('attempt must be a positive integer');
  }
  if (
    !Number.isFinite(policy.baseDelayMs) ||
    policy.baseDelayMs < 0 ||
    !Number.isFinite(policy.multiplier) ||
    policy.multiplier < 1 ||
    !Number.isFinite(policy.maxDelayMs) ||
    policy.maxDelayMs < policy.baseDelayMs ||
    !Number.isFinite(policy.jitterRatio) ||
    policy.jitterRatio < 0 ||
    policy.jitterRatio > 1
  ) {
    throw new RangeError('invalid notification retry policy');
  }

  const exponential = Math.min(
    policy.baseDelayMs * policy.multiplier ** (attempt - 1),
    policy.maxDelayMs,
  );
  const jitter = exponential * policy.jitterRatio;
  const randomUnit = Math.min(1, Math.max(0, random()));
  return Math.min(
    policy.maxDelayMs,
    Math.round(exponential - jitter + 2 * jitter * randomUnit),
  );
}

export interface NotificationDeliveryHandler {
  /**
   * Must forward idempotencyKey to providers that support idempotent sends.
   * deliveryRef is resolved by the application and must not be logged by the
   * generic worker.
   */
  deliver(input: {
    deliveryRef: string;
    channel: NotifyChannel;
    idempotencyKey: string;
    attempt: number;
    signal?: AbortSignal;
  }): Promise<{ providerMessageId?: string }>;
}

export type NotificationDeliveryAttemptOutcome =
  | 'DELIVERED'
  | 'RETRYING'
  | 'DEAD'
  | 'LOST_LEASE'
  | 'ERROR';

/** Safe operational event: deliberately excludes IDs, recipients and content. */
export interface NotificationDeliveryAttemptEvent {
  channel: NotifyChannel;
  outcome: NotificationDeliveryAttemptOutcome;
  attempt: number;
  durationMs: number;
  errorCode?: string;
}

export interface NotificationDeliveryObserver {
  onAttemptFinished(event: NotificationDeliveryAttemptEvent): void;
}
