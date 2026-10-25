import { randomUUID } from 'node:crypto';
import {
  NotificationIdempotencyConflictError, NotificationLeaseLostError, validateNotificationDeliveryInput,
  type NotificationDeliveryClaim, type NotificationDeliveryInput, type NotificationDeliveryRecord,
  type NotificationDeliveryRepository,
} from './durable-delivery';

export interface NotificationSqlClient {
  query<TRow>(sql: string, parameters?: readonly unknown[]): Promise<{ rows: TRow[] }>;
}

interface DeliveryRow extends Omit<NotificationDeliveryRecord,
  'availableAt' | 'createdAt' | 'updatedAt' | 'deliveredAt' | 'failedAt' | 'leaseExpiresAt'
  | 'workerId' | 'leaseToken' | 'providerMessageId' | 'errorCode' | 'errorRetryable'> {
  availableAt: Date | string;
  createdAt: Date | string;
  updatedAt: Date | string;
  deliveredAt: Date | string | null;
  failedAt: Date | string | null;
  leaseExpiresAt: Date | string | null;
  workerId: string | null;
  leaseToken: string | null;
  providerMessageId: string | null;
  errorCode: string | null;
  errorRetryable: boolean | null;
}
const clearLease = '"workerId"=NULL, "leaseToken"=NULL, "leaseExpiresAt"=NULL';
function toRecord(row: DeliveryRow): NotificationDeliveryRecord {
  return { ...row, availableAt: new Date(row.availableAt), createdAt: new Date(row.createdAt), updatedAt: new Date(row.updatedAt),
    deliveredAt: row.deliveredAt ? new Date(row.deliveredAt) : undefined,
    failedAt: row.failedAt ? new Date(row.failedAt) : undefined,
    leaseExpiresAt: row.leaseExpiresAt ? new Date(row.leaseExpiresAt) : undefined,
    workerId: row.workerId ?? undefined, leaseToken: row.leaseToken ?? undefined,
    providerMessageId: row.providerMessageId ?? undefined, errorCode: row.errorCode ?? undefined,
    errorRetryable: row.errorRetryable ?? undefined };
}
function date(value: Date): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new RangeError('A valid delivery time is required');
}
function leaseExpiry(now: Date, leaseMs: number): Date {
  date(now);
  const expiresAt = new Date(now.getTime() + leaseMs);
  if (!Number.isFinite(leaseMs) || leaseMs <= 0 || !Number.isFinite(expiresAt.getTime()) || expiresAt <= now)
    throw new RangeError('A positive delivery lease is required');
  return expiresAt;
}

/** Neutral PostgreSQL metadata adapter. Content, recipients, transactions and pooling belong to the host. */
export class PostgresNotificationDeliveryRepository implements NotificationDeliveryRepository {
  constructor(private readonly client: NotificationSqlClient) {}

  async enqueue(request: NotificationDeliveryInput): Promise<{ delivery: NotificationDeliveryRecord; created: boolean }> {
    const input = structuredClone(request);
    validateNotificationDeliveryInput(input);
    const at = input.createdAt ?? new Date();
    const inserted = await this.client.query<DeliveryRow>(`
      INSERT INTO notification_deliveries ("id", "idempotencyKey", "idempotencyFingerprint", "channel", "deliveryRef", "priority", "maxAttempts", "availableAt", "createdAt", "updatedAt")
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)
      ON CONFLICT ("idempotencyKey") DO NOTHING RETURNING *
    `, [input.id, input.idempotencyKey, input.idempotencyFingerprint, input.channel, input.deliveryRef,
      input.priority ?? 0, input.maxAttempts, input.availableAt ?? at, at]);
    if (inserted.rows[0]) return { delivery: toRecord(inserted.rows[0]), created: true };
    // Use a fresh statement snapshot after a concurrent INSERT's conflict wait.
    const existing = await this.client.query<DeliveryRow>(
      'SELECT * FROM notification_deliveries WHERE "idempotencyKey"=$1', [input.idempotencyKey]);
    const row = existing.rows[0];
    if (!row) throw new Error('Notification delivery disappeared after conflict');
    if (row.idempotencyFingerprint !== input.idempotencyFingerprint)
      throw new NotificationIdempotencyConflictError(input.idempotencyKey);
    return { delivery: toRecord(row), created: false };
  }

  async claimNext(input: { workerId: string; now: Date; leaseMs: number }): Promise<NotificationDeliveryClaim | null> {
    if (!input.workerId.trim()) throw new RangeError('workerId is required');
    const expiresAt = leaseExpiry(input.now, input.leaseMs);
    const result = await this.client.query<DeliveryRow>(`
      WITH candidate AS (
        SELECT "id" FROM notification_deliveries
        WHERE "status" IN ('PENDING','RETRYING') AND "availableAt" <= $1 AND "attempt" < "maxAttempts"
        ORDER BY "priority" DESC, "availableAt", "createdAt", "id" FOR UPDATE SKIP LOCKED LIMIT 1
      )
      UPDATE notification_deliveries AS delivery SET "status"='PROCESSING', "attempt"=delivery."attempt"+1,
        "workerId"=$2, "leaseToken"=$3, "leaseExpiresAt"=$4, "updatedAt"=$1, "version"=delivery."version"+1
      FROM candidate WHERE delivery."id"=candidate."id" RETURNING delivery.*
    `, [input.now, input.workerId, randomUUID(), expiresAt]);
    return result.rows[0] ? toRecord(result.rows[0]) as NotificationDeliveryClaim : null;
  }

  async recoverExpiredLeases(now: Date): Promise<{ retried: number; dead: number }> {
    date(now);
    const result = await this.client.query<{ retried: number; dead: number }>(`
      WITH recovered AS (
        UPDATE notification_deliveries SET
          "status"=CASE WHEN "attempt">="maxAttempts" THEN 'DEAD' ELSE 'RETRYING' END,
          "errorCode"='NOTIFICATION_LEASE_EXPIRED', "errorRetryable"=("attempt"<"maxAttempts"),
          "availableAt"=CASE WHEN "attempt"<"maxAttempts" THEN $1 ELSE "availableAt" END,
          "failedAt"=CASE WHEN "attempt">="maxAttempts" THEN $1 ELSE "failedAt" END,
          ${clearLease}, "updatedAt"=$1, "version"="version"+1
        WHERE "status"='PROCESSING' AND "leaseExpiresAt" <= $1 RETURNING "status"
      ) SELECT COUNT(*) FILTER (WHERE "status"='RETRYING')::integer AS retried,
        COUNT(*) FILTER (WHERE "status"='DEAD')::integer AS dead FROM recovered
    `, [now]);
    return result.rows[0];
  }

  async extendLease(input: { id: string; leaseToken: string; now: Date; leaseMs: number }): Promise<NotificationDeliveryClaim> {
    const expiresAt = leaseExpiry(input.now, input.leaseMs);
    return await this.activeUpdate(input, '"leaseExpiresAt"=$4', [expiresAt]) as NotificationDeliveryClaim;
  }
  markDelivered(input: { id: string; leaseToken: string; providerMessageId?: string; now: Date }): Promise<NotificationDeliveryRecord> {
    return this.activeUpdate(input, `"status"='DELIVERED', "providerMessageId"=$4, "deliveredAt"=$3,
      "errorCode"=NULL, "errorRetryable"=NULL, ${clearLease}`, [input.providerMessageId ?? null]);
  }
  scheduleRetry(input: { id: string; leaseToken: string; errorCode: string; availableAt: Date; now: Date }): Promise<NotificationDeliveryRecord> {
    date(input.availableAt);
    return this.activeUpdate(input, `"status"='RETRYING', "errorCode"=$4, "errorRetryable"=TRUE,
      "availableAt"=$5, ${clearLease}`, [input.errorCode, input.availableAt]);
  }
  markDead(input: { id: string; leaseToken: string; errorCode: string; retryable: boolean; now: Date }): Promise<NotificationDeliveryRecord> {
    return this.activeUpdate(input, `"status"='DEAD', "errorCode"=$4, "errorRetryable"=$5,
      "failedAt"=$3, ${clearLease}`, [input.errorCode, input.retryable]);
  }
  async getById(id: string): Promise<NotificationDeliveryRecord | null> {
    const result = await this.client.query<DeliveryRow>('SELECT * FROM notification_deliveries WHERE "id"=$1', [id]);
    return result.rows[0] ? toRecord(result.rows[0]) : null;
  }

  private async activeUpdate(input: { id: string; leaseToken: string; now: Date }, assignments: string,
    values: readonly unknown[]): Promise<NotificationDeliveryRecord> {
    date(input.now);
    const result = await this.client.query<DeliveryRow>(`
      UPDATE notification_deliveries SET ${assignments}, "updatedAt"=$3, "version"="version"+1
      WHERE "id"=$1 AND "status"='PROCESSING' AND "leaseToken"=$2 AND "leaseExpiresAt">$3 RETURNING *
    `, [input.id, input.leaseToken, input.now, ...values]);
    if (!result.rows[0]) throw new NotificationLeaseLostError(input.id);
    return toRecord(result.rows[0]);
  }
}
