import { describe, expect, it, vi } from 'vitest';
import { NotifyChannel } from './notifier.interface';
import {
  NotificationDeliveryError,
  type NotificationDeliveryHandler,
} from './durable-delivery';
import { DurableNotificationWorker } from './durable-notification-worker';
import { InMemoryDurableNotificationRepository } from './in-memory-durable-delivery.repository';

const T0 = new Date('2026-08-17T00:00:00.000Z');

async function setup(options?: {
  maxAttempts?: number;
  handler?: NotificationDeliveryHandler;
  leaseMs?: number;
  observer?: { onAttemptFinished: ReturnType<typeof vi.fn> };
  durationClock?: () => number;
}) {
  const repository = new InMemoryDurableNotificationRepository();
  await repository.enqueue({
    id: 'delivery-1',
    idempotencyKey: 'delivery-key-1',
    idempotencyFingerprint: 'sha256:one',
    channel: NotifyChannel.EMAIL,
    deliveryRef: 'notification-row-1',
    maxAttempts: options?.maxAttempts ?? 3,
    availableAt: T0,
    createdAt: T0,
  });
  let clock = new Date(T0.getTime() + 10);
  const handler =
    options?.handler ??
    ({
      deliver: vi.fn().mockResolvedValue({ providerMessageId: 'provider-1' }),
    } satisfies NotificationDeliveryHandler);
  const worker = new DurableNotificationWorker(repository, handler, {
    leaseMs: options?.leaseMs ?? 1_000,
    retryPolicy: {
      baseDelayMs: 1_000,
      multiplier: 2,
      maxDelayMs: 10_000,
      jitterRatio: 0,
    },
    random: () => 0.5,
    clock: () => new Date(clock),
    observer: options?.observer,
    durationClock: options?.durationClock,
  });
  return {
    repository,
    handler,
    worker,
    setClock(value: Date) {
      clock = new Date(value);
    },
  };
}

describe('DurableNotificationWorker', () => {
  it('成功投递并保存 Provider message ID', async () => {
    const { repository, handler, worker } = await setup();

    expect(await worker.runOnce({ workerId: 'worker-1', now: T0 })).toEqual({
      kind: 'delivered',
      deliveryId: 'delivery-1',
    });
    expect(handler.deliver).toHaveBeenCalledWith({
      deliveryRef: 'notification-row-1',
      channel: NotifyChannel.EMAIL,
      idempotencyKey: 'delivery-key-1',
      attempt: 1,
      signal: expect.any(AbortSignal),
    });
    expect(await repository.getById('delivery-1')).toMatchObject({
      status: 'DELIVERED',
      providerMessageId: 'provider-1',
    });
  });

  it('发布不含业务标识和内容的安全投递观测事件', async () => {
    const observer = { onAttemptFinished: vi.fn() };
    const durationClock = vi.fn().mockReturnValueOnce(100).mockReturnValueOnce(125);
    const { worker } = await setup({ observer, durationClock });

    await worker.runOnce({ workerId: 'worker-1', now: T0 });

    expect(observer.onAttemptFinished).toHaveBeenCalledWith({
      channel: NotifyChannel.EMAIL,
      outcome: 'DELIVERED',
      attempt: 1,
      durationMs: 25,
    });
    const serialized = JSON.stringify(observer.onAttemptFinished.mock.calls);
    expect(serialized).not.toContain('delivery-1');
    expect(serialized).not.toContain('delivery-key-1');
    expect(serialized).not.toContain('notification-row-1');
  });

  it('观测器失败不会把成功投递改成失败', async () => {
    const observer = {
      onAttemptFinished: vi.fn(() => {
        throw new Error('metrics unavailable');
      }),
    };
    const { repository, worker } = await setup({ observer });

    await expect(
      worker.runOnce({ workerId: 'worker-1', now: T0 }),
    ).resolves.toEqual({ kind: 'delivered', deliveryId: 'delivery-1' });
    await expect(repository.getById('delivery-1')).resolves.toMatchObject({
      status: 'DELIVERED',
    });
  });

  it('持久化投递结果失败时发布安全 ERROR 事件并保留原异常', async () => {
    const observer = { onAttemptFinished: vi.fn() };
    const context = await setup({
      observer,
      handler: {
        deliver: vi.fn().mockRejectedValue(
          new NotificationDeliveryError(
            'provider unavailable',
            'PROVIDER_UNAVAILABLE',
            true,
          ),
        ),
      },
    });
    vi.spyOn(context.repository, 'scheduleRetry').mockRejectedValue(
      new Error('database unavailable'),
    );

    await expect(
      context.worker.runOnce({ workerId: 'worker-1', now: T0 }),
    ).rejects.toThrow('database unavailable');
    expect(observer.onAttemptFinished).toHaveBeenCalledWith({
      channel: NotifyChannel.EMAIL,
      outcome: 'ERROR',
      attempt: 1,
      durationMs: expect.any(Number),
    });
  });

  it('does not reschedule an accepted message when the DELIVERED commit fails transiently', async () => {
    const context = await setup();
    const original = context.repository.markDelivered.bind(context.repository);
    const markDelivered = vi
      .spyOn(context.repository, 'markDelivered')
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockImplementation(original);
    const scheduleRetry = vi.spyOn(context.repository, 'scheduleRetry');

    await expect(
      context.worker.runOnce({ workerId: 'worker-1', now: T0 }),
    ).resolves.toEqual({ kind: 'delivered', deliveryId: 'delivery-1' });
    expect(markDelivered).toHaveBeenCalledTimes(2);
    expect(scheduleRetry).not.toHaveBeenCalled();
    expect(context.handler.deliver).toHaveBeenCalledTimes(1);
  });

  it('leaves the lease to expire instead of re-queueing when the DELIVERED commit keeps failing', async () => {
    const context = await setup();
    vi.spyOn(context.repository, 'markDelivered').mockRejectedValue(new Error('database down'));
    const scheduleRetry = vi.spyOn(context.repository, 'scheduleRetry');
    const markDead = vi.spyOn(context.repository, 'markDead');

    await expect(
      context.worker.runOnce({ workerId: 'worker-1', now: T0 }),
    ).rejects.toThrow('database down');
    expect(scheduleRetry).not.toHaveBeenCalled();
    expect(markDead).not.toHaveBeenCalled();
    expect(await context.repository.getById('delivery-1')).toMatchObject({ status: 'PROCESSING' });
  });

  it('可重试错误按退避时间重新排队并复用幂等键', async () => {
    const deliver = vi
      .fn()
      .mockRejectedValueOnce(
        new NotificationDeliveryError(
          'provider overloaded',
          'PROVIDER_RATE_LIMITED',
          true,
          5_000,
        ),
      )
      .mockResolvedValueOnce({ providerMessageId: 'provider-2' });
    const context = await setup({ handler: { deliver } });

    expect(
      await context.worker.runOnce({ workerId: 'worker-1', now: T0 }),
    ).toEqual({
      kind: 'retry-scheduled',
      deliveryId: 'delivery-1',
      availableAt: new Date(T0.getTime() + 5_010),
    });
    expect(await context.repository.getById('delivery-1')).toMatchObject({
      status: 'RETRYING',
      errorCode: 'PROVIDER_RATE_LIMITED',
      attempt: 1,
    });

    const retryAt = new Date(T0.getTime() + 5_010);
    context.setClock(new Date(retryAt.getTime() + 10));
    expect(
      await context.worker.runOnce({ workerId: 'worker-2', now: retryAt }),
    ).toEqual({ kind: 'delivered', deliveryId: 'delivery-1' });
    expect(deliver.mock.calls[0][0].idempotencyKey).toBe('delivery-key-1');
    expect(deliver.mock.calls[1][0].idempotencyKey).toBe('delivery-key-1');
    expect(deliver.mock.calls[1][0].attempt).toBe(2);
  });

  it('不可重试错误直接进入死信且不保存错误原文', async () => {
    const context = await setup({
      handler: {
        deliver: vi.fn().mockRejectedValue(
          new NotificationDeliveryError(
            'recipient@example.com rejected permanently',
            'RECIPIENT_REJECTED',
            false,
          ),
        ),
      },
    });

    expect(
      await context.worker.runOnce({ workerId: 'worker-1', now: T0 }),
    ).toEqual({
      kind: 'dead',
      deliveryId: 'delivery-1',
      errorCode: 'RECIPIENT_REJECTED',
    });
    const record = await context.repository.getById('delivery-1');
    expect(record).toMatchObject({
      status: 'DEAD',
      errorCode: 'RECIPIENT_REJECTED',
      errorRetryable: false,
    });
    expect(JSON.stringify(record)).not.toContain('recipient@example.com');
  });

  it('未知错误默认重试，但达到最大次数后进入死信', async () => {
    const context = await setup({
      maxAttempts: 1,
      handler: { deliver: vi.fn().mockRejectedValue(new Error('secret body')) },
    });

    expect(
      await context.worker.runOnce({ workerId: 'worker-1', now: T0 }),
    ).toEqual({
      kind: 'dead',
      deliveryId: 'delivery-1',
      errorCode: 'NOTIFICATION_DELIVERY_FAILED',
    });
    expect(JSON.stringify(await context.repository.getById('delivery-1'))).not
      .toContain('secret body');
  });

  it('进程取消后重新排队，不把取消误判为最终失败', async () => {
    const controller = new AbortController();
    controller.abort();
    const context = await setup({
      handler: { deliver: vi.fn().mockRejectedValue(new Error('aborted')) },
    });

    expect(
      await context.worker.runOnce({
        workerId: 'worker-1',
        now: T0,
        signal: controller.signal,
      }),
    ).toEqual({
      kind: 'retry-scheduled',
      deliveryId: 'delivery-1',
      availableAt: new Date(T0.getTime() + 1_010),
    });
    expect(await context.repository.getById('delivery-1')).toMatchObject({
      status: 'RETRYING',
      errorCode: 'NOTIFICATION_WORKER_ABORTED',
    });
  });

  it('Provider 返回时租约已过期，旧 Worker 不能提交成功', async () => {
    const context = await setup({ leaseMs: 100 });
    context.setClock(new Date(T0.getTime() + 100));

    expect(
      await context.worker.runOnce({ workerId: 'worker-old', now: T0 }),
    ).toEqual({ kind: 'lost-lease', deliveryId: 'delivery-1' });
    expect(await context.repository.getById('delivery-1')).toMatchObject({
      status: 'PROCESSING',
      attempt: 1,
    });
  });

  it('慢 Provider 通过心跳续租，不因超过初始租约而重复认领', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    try {
      const repository = new InMemoryDurableNotificationRepository();
      await repository.enqueue({
        id: 'delivery-1',
        idempotencyKey: 'delivery-key-1',
        idempotencyFingerprint: 'sha256:one',
        channel: NotifyChannel.EMAIL,
        deliveryRef: 'notification-row-1',
        maxAttempts: 3,
        availableAt: T0,
        createdAt: T0,
      });
      const worker = new DurableNotificationWorker(
        repository,
        {
          deliver: vi.fn().mockImplementation(
            () =>
              new Promise<{ providerMessageId: string }>((resolve) =>
                setTimeout(
                  () => resolve({ providerMessageId: 'provider-slow' }),
                  250,
                ),
              ),
          ),
        },
        { leaseMs: 90, heartbeatMs: 30 },
      );

      const delivery = worker.runOnce({ workerId: 'worker-1', now: T0 });
      await vi.advanceTimersByTimeAsync(250);

      await expect(delivery).resolves.toEqual({
        kind: 'delivered',
        deliveryId: 'delivery-1',
      });
      expect(await repository.getById('delivery-1')).toMatchObject({
        status: 'DELIVERED',
        attempt: 1,
        providerMessageId: 'provider-slow',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('没有待投递记录时返回 idle', async () => {
    const repository = new InMemoryDurableNotificationRepository();
    const worker = new DurableNotificationWorker(
      repository,
      { deliver: vi.fn() },
      { leaseMs: 1_000 },
    );

    await expect(
      worker.runOnce({ workerId: 'worker-1', now: T0 }),
    ).resolves.toEqual({ kind: 'idle' });
  });
});
