import { describe, expect, it, vi } from 'vitest';
import { PostgresNotificationDeliveryRepository, type NotificationSqlClient } from './postgres-durable-delivery.repository';
import { NotificationIdempotencyConflictError, NotificationLeaseLostError, type NotificationDeliveryInput } from './durable-delivery';
import { NotifyChannel } from './notifier.interface';

const now = new Date('2026-10-24T00:00:00.000Z');
const input = (): NotificationDeliveryInput => ({ id: 'mail-1', idempotencyKey: 'owned-key', idempotencyFingerprint: 'original',
  channel: NotifyChannel.EMAIL, deliveryRef: 'private-envelope', maxAttempts: 3, createdAt: new Date(now) });
const stored = () => ({ ...input(), priority: 0, status: 'PENDING', attempt: 0, availableAt: now, updatedAt: now, version: 0,
  deliveredAt: null, failedAt: null, leaseExpiresAt: null, workerId: null, leaseToken: null, providerMessageId: null, errorCode: null, errorRetryable: null });

describe('PostgresNotificationDeliveryRepository port contract', () => {
  it('keeps the original idempotency identity across the concurrent-conflict wait', async () => {
    let resolve!: (value: { rows: unknown[] }) => void;
    const pending = new Promise<{ rows: unknown[] }>(done => { resolve = done; });
    const query = vi.fn().mockReturnValueOnce(pending).mockResolvedValueOnce({ rows: [stored()] });
    const repository = new PostgresNotificationDeliveryRepository({ query } as NotificationSqlClient);
    const request = input(), result = repository.enqueue(request);
    request.idempotencyKey = 'mutated-key'; request.idempotencyFingerprint = 'mutated'; request.createdAt!.setTime(0);
    resolve({ rows: [] });
    expect(await result).toMatchObject({ created: false, delivery: { idempotencyKey: 'owned-key', createdAt: now } });
    expect(query.mock.calls[1][1]).toEqual(['owned-key']);
  });

  it('rejects mismatched fingerprints after a conflict without rewriting an existing reservation', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [stored()] });
    const repository = new PostgresNotificationDeliveryRepository({ query } as NotificationSqlClient);
    await expect(repository.enqueue({ ...input(), idempotencyFingerprint: 'different' })).rejects.toBeInstanceOf(NotificationIdempotencyConflictError);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('reports rejected lease compare-and-swap without falsely confirming delivery', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const repository = new PostgresNotificationDeliveryRepository({ query } as NotificationSqlClient);
    await expect(repository.markDelivered({ id: 'mail-1', leaseToken: 'stale', now })).rejects.toBeInstanceOf(NotificationLeaseLostError);
    await expect(repository.extendLease({ id: 'mail-1', leaseToken: 'stale', now, leaseMs: 1000 })).rejects.toBeInstanceOf(NotificationLeaseLostError);
  });

  it('rejects invalid lease times before executing SQL', async () => {
    const query = vi.fn(), repository = new PostgresNotificationDeliveryRepository({ query } as NotificationSqlClient);
    await expect(repository.claimNext({ workerId: 'w', now, leaseMs: 0 })).rejects.toThrow(RangeError);
    await expect(repository.extendLease({ id: 'mail-1', leaseToken: 'lease', now: new Date('invalid'), leaseMs: 10 })).rejects.toThrow(RangeError);
    expect(query).not.toHaveBeenCalled();
  });
});
