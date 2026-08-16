import { describe, expect, it } from 'vitest';
import { NotifyChannel } from './notifier.interface';
import {
  NotificationIdempotencyConflictError,
  NotificationLeaseLostError,
  type NotificationDeliveryInput,
} from './durable-delivery';
import { InMemoryDurableNotificationRepository } from './in-memory-durable-delivery.repository';

const T0 = new Date('2026-08-17T00:00:00.000Z');

function input(
  overrides: Partial<NotificationDeliveryInput> = {},
): NotificationDeliveryInput {
  return {
    id: 'delivery-1',
    idempotencyKey: 'monitor-alert:1:email',
    idempotencyFingerprint: 'sha256:one',
    channel: NotifyChannel.EMAIL,
    deliveryRef: 'notification-row-1',
    maxAttempts: 3,
    createdAt: T0,
    availableAt: T0,
    ...overrides,
  };
}

describe('InMemoryDurableNotificationRepository', () => {
  it('相同幂等键和指纹只创建一次', async () => {
    const repository = new InMemoryDurableNotificationRepository();

    const first = await repository.enqueue(input());
    const replay = await repository.enqueue(
      input({ id: 'delivery-replayed' }),
    );

    expect(first.created).toBe(true);
    expect(replay.created).toBe(false);
    expect(replay.delivery.id).toBe('delivery-1');
  });

  it('相同幂等键异参立即拒绝', async () => {
    const repository = new InMemoryDurableNotificationRepository();
    await repository.enqueue(input());

    await expect(
      repository.enqueue(
        input({
          id: 'delivery-2',
          idempotencyFingerprint: 'sha256:different',
        }),
      ),
    ).rejects.toBeInstanceOf(NotificationIdempotencyConflictError);
  });

  it('按优先级和可用时间原子认领', async () => {
    const repository = new InMemoryDurableNotificationRepository();
    await repository.enqueue(input({ id: 'normal', priority: 0 }));
    await repository.enqueue(
      input({
        id: 'urgent',
        idempotencyKey: 'urgent',
        idempotencyFingerprint: 'urgent-fingerprint',
        priority: 10,
      }),
    );

    const claim = await repository.claimNext({
      workerId: 'worker-1',
      now: T0,
      leaseMs: 1_000,
    });

    expect(claim).toMatchObject({
      id: 'urgent',
      status: 'PROCESSING',
      attempt: 1,
      workerId: 'worker-1',
    });
    expect(claim?.leaseToken).toBeTruthy();
  });

  it('拒绝过期租约和旧 Worker 的迟到回写', async () => {
    const repository = new InMemoryDurableNotificationRepository();
    await repository.enqueue(input());
    const first = await repository.claimNext({
      workerId: 'worker-old',
      now: T0,
      leaseMs: 100,
    });
    const expiredAt = new Date(T0.getTime() + 100);

    await expect(
      repository.markDelivered({
        id: first!.id,
        leaseToken: first!.leaseToken,
        now: expiredAt,
      }),
    ).rejects.toBeInstanceOf(NotificationLeaseLostError);

    expect(await repository.recoverExpiredLeases(expiredAt)).toEqual({
      retried: 1,
      dead: 0,
    });
    const second = await repository.claimNext({
      workerId: 'worker-new',
      now: expiredAt,
      leaseMs: 100,
    });
    expect(second?.attempt).toBe(2);

    await expect(
      repository.markDelivered({
        id: first!.id,
        leaseToken: first!.leaseToken,
        now: new Date(expiredAt.getTime() + 1),
      }),
    ).rejects.toBeInstanceOf(NotificationLeaseLostError);
    await repository.markDelivered({
      id: second!.id,
      leaseToken: second!.leaseToken,
      providerMessageId: 'provider-1',
      now: new Date(expiredAt.getTime() + 1),
    });
    expect(await repository.getById('delivery-1')).toMatchObject({
      status: 'DELIVERED',
      providerMessageId: 'provider-1',
      attempt: 2,
    });
  });

  it('续租延长处理窗口但不增加 attempt', async () => {
    const repository = new InMemoryDurableNotificationRepository();
    await repository.enqueue(input());
    const claim = await repository.claimNext({
      workerId: 'worker-1',
      now: T0,
      leaseMs: 100,
    });
    const renewedAt = new Date(T0.getTime() + 50);

    const renewed = await repository.extendLease({
      id: claim!.id,
      leaseToken: claim!.leaseToken,
      now: renewedAt,
      leaseMs: 100,
    });

    expect(renewed).toMatchObject({
      attempt: 1,
      leaseExpiresAt: new Date(T0.getTime() + 150),
      version: 2,
    });
    expect(
      await repository.recoverExpiredLeases(new Date(T0.getTime() + 100)),
    ).toEqual({ retried: 0, dead: 0 });
  });

  it('最后一次尝试的租约过期后进入死信', async () => {
    const repository = new InMemoryDurableNotificationRepository();
    await repository.enqueue(input({ maxAttempts: 1 }));
    await repository.claimNext({
      workerId: 'worker-1',
      now: T0,
      leaseMs: 100,
    });

    expect(
      await repository.recoverExpiredLeases(new Date(T0.getTime() + 100)),
    ).toEqual({ retried: 0, dead: 1 });
    expect(await repository.getById('delivery-1')).toMatchObject({
      status: 'DEAD',
      errorCode: 'NOTIFICATION_LEASE_EXPIRED',
      errorRetryable: false,
    });
  });

  it('返回副本，调用方不能绕过仓储修改状态', async () => {
    const repository = new InMemoryDurableNotificationRepository();
    const created = await repository.enqueue(input());
    created.delivery.status = 'DELIVERED';
    created.delivery.availableAt.setUTCFullYear(2030);

    expect(await repository.getById('delivery-1')).toMatchObject({
      status: 'PENDING',
      availableAt: T0,
    });
  });
});
