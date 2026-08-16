import { randomUUID } from 'node:crypto';
import {
  NotificationIdempotencyConflictError,
  NotificationLeaseLostError,
  validateNotificationDeliveryInput,
  type NotificationDeliveryClaim,
  type NotificationDeliveryInput,
  type NotificationDeliveryRecord,
  type NotificationDeliveryRepository,
} from './durable-delivery';

function clone(record: NotificationDeliveryRecord): NotificationDeliveryRecord {
  return {
    ...record,
    availableAt: new Date(record.availableAt),
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
    leaseExpiresAt: record.leaseExpiresAt
      ? new Date(record.leaseExpiresAt)
      : undefined,
    deliveredAt: record.deliveredAt ? new Date(record.deliveredAt) : undefined,
    failedAt: record.failedAt ? new Date(record.failedAt) : undefined,
  };
}

/** Test/reference implementation. Production applications provide SQL storage. */
export class InMemoryDurableNotificationRepository
  implements NotificationDeliveryRepository
{
  private readonly records = new Map<string, NotificationDeliveryRecord>();
  private readonly idempotencyIndex = new Map<string, string>();

  async enqueue(input: NotificationDeliveryInput): Promise<{
    delivery: NotificationDeliveryRecord;
    created: boolean;
  }> {
    validateNotificationDeliveryInput(input);
    const existingId = this.idempotencyIndex.get(input.idempotencyKey);
    if (existingId) {
      const existing = this.records.get(existingId);
      if (!existing) {
        throw new Error('Notification idempotency index is inconsistent');
      }
      if (existing.idempotencyFingerprint !== input.idempotencyFingerprint) {
        throw new NotificationIdempotencyConflictError(input.idempotencyKey);
      }
      return { delivery: clone(existing), created: false };
    }
    if (this.records.has(input.id)) {
      throw new Error(`Notification delivery ID already exists: ${input.id}`);
    }

    const createdAt = new Date(input.createdAt ?? new Date());
    const record: NotificationDeliveryRecord = {
      id: input.id,
      idempotencyKey: input.idempotencyKey,
      idempotencyFingerprint: input.idempotencyFingerprint,
      channel: input.channel,
      deliveryRef: input.deliveryRef,
      priority: input.priority ?? 0,
      status: 'PENDING',
      attempt: 0,
      maxAttempts: input.maxAttempts,
      availableAt: new Date(input.availableAt ?? createdAt),
      createdAt,
      updatedAt: createdAt,
      version: 0,
    };
    this.records.set(record.id, record);
    this.idempotencyIndex.set(record.idempotencyKey, record.id);
    return { delivery: clone(record), created: true };
  }

  async claimNext(input: {
    workerId: string;
    now: Date;
    leaseMs: number;
  }): Promise<NotificationDeliveryClaim | null> {
    if (!input.workerId || !Number.isFinite(input.leaseMs) || input.leaseMs <= 0) {
      throw new RangeError('workerId and positive leaseMs are required');
    }
    const due = [...this.records.values()]
      .filter(
        (record) =>
          (record.status === 'PENDING' || record.status === 'RETRYING') &&
          record.availableAt <= input.now &&
          record.attempt < record.maxAttempts,
      )
      .sort(
        (left, right) =>
          right.priority - left.priority ||
          left.availableAt.getTime() - right.availableAt.getTime() ||
          left.createdAt.getTime() - right.createdAt.getTime(),
      )[0];
    if (!due) return null;

    due.status = 'PROCESSING';
    due.attempt += 1;
    due.workerId = input.workerId;
    due.leaseToken = randomUUID();
    due.leaseExpiresAt = new Date(input.now.getTime() + input.leaseMs);
    due.updatedAt = new Date(input.now);
    due.version += 1;
    return clone(due) as NotificationDeliveryClaim;
  }

  async recoverExpiredLeases(
    now: Date,
  ): Promise<{ retried: number; dead: number }> {
    let retried = 0;
    let dead = 0;
    for (const record of this.records.values()) {
      if (
        record.status !== 'PROCESSING' ||
        !record.leaseExpiresAt ||
        record.leaseExpiresAt > now
      ) {
        continue;
      }
      this.clearLease(record);
      record.updatedAt = new Date(now);
      record.version += 1;
      if (record.attempt >= record.maxAttempts) {
        record.status = 'DEAD';
        record.errorCode = 'NOTIFICATION_LEASE_EXPIRED';
        record.errorRetryable = false;
        record.failedAt = new Date(now);
        dead += 1;
      } else {
        record.status = 'RETRYING';
        record.errorCode = 'NOTIFICATION_LEASE_EXPIRED';
        record.errorRetryable = true;
        record.availableAt = new Date(now);
        retried += 1;
      }
    }
    return { retried, dead };
  }

  async extendLease(input: {
    id: string;
    leaseToken: string;
    now: Date;
    leaseMs: number;
  }): Promise<NotificationDeliveryClaim> {
    if (!Number.isFinite(input.leaseMs) || input.leaseMs <= 0) {
      throw new RangeError('leaseMs must be positive');
    }
    const record = this.activeLease(input.id, input.leaseToken, input.now);
    record.leaseExpiresAt = new Date(input.now.getTime() + input.leaseMs);
    record.updatedAt = new Date(input.now);
    record.version += 1;
    return clone(record) as NotificationDeliveryClaim;
  }

  async markDelivered(input: {
    id: string;
    leaseToken: string;
    providerMessageId?: string;
    now: Date;
  }): Promise<NotificationDeliveryRecord> {
    const record = this.activeLease(input.id, input.leaseToken, input.now);
    record.status = 'DELIVERED';
    record.providerMessageId = input.providerMessageId;
    record.errorCode = undefined;
    record.errorRetryable = undefined;
    record.deliveredAt = new Date(input.now);
    record.updatedAt = new Date(input.now);
    record.version += 1;
    this.clearLease(record);
    return clone(record);
  }

  async scheduleRetry(input: {
    id: string;
    leaseToken: string;
    errorCode: string;
    availableAt: Date;
    now: Date;
  }): Promise<NotificationDeliveryRecord> {
    const record = this.activeLease(input.id, input.leaseToken, input.now);
    if (record.attempt >= record.maxAttempts) {
      throw new Error('Cannot schedule retry after maxAttempts is exhausted');
    }
    record.status = 'RETRYING';
    record.errorCode = input.errorCode;
    record.errorRetryable = true;
    record.availableAt = new Date(input.availableAt);
    record.updatedAt = new Date(input.now);
    record.version += 1;
    this.clearLease(record);
    return clone(record);
  }

  async markDead(input: {
    id: string;
    leaseToken: string;
    errorCode: string;
    retryable: boolean;
    now: Date;
  }): Promise<NotificationDeliveryRecord> {
    const record = this.activeLease(input.id, input.leaseToken, input.now);
    record.status = 'DEAD';
    record.errorCode = input.errorCode;
    record.errorRetryable = input.retryable;
    record.failedAt = new Date(input.now);
    record.updatedAt = new Date(input.now);
    record.version += 1;
    this.clearLease(record);
    return clone(record);
  }

  async getById(id: string): Promise<NotificationDeliveryRecord | null> {
    const record = this.records.get(id);
    return record ? clone(record) : null;
  }

  private activeLease(
    id: string,
    leaseToken: string,
    now: Date,
  ): NotificationDeliveryRecord {
    const record = this.records.get(id);
    if (
      !record ||
      record.status !== 'PROCESSING' ||
      record.leaseToken !== leaseToken ||
      !record.leaseExpiresAt ||
      record.leaseExpiresAt <= now
    ) {
      throw new NotificationLeaseLostError(id);
    }
    return record;
  }

  private clearLease(record: NotificationDeliveryRecord): void {
    record.workerId = undefined;
    record.leaseToken = undefined;
    record.leaseExpiresAt = undefined;
  }

}
