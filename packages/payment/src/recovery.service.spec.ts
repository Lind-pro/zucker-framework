import { PaymentRecoveryService, type RecoveryAttemptStore } from './recovery.service';
import { OrderService, OrderNotFoundError } from './order.service';

describe('persistent payment recovery attempts', () => {
  const failed = {
    id: 'order',
    status: 'failed',
    amount: 100,
    currency: 'USD',
    metadata: { email: 'fixture@example.test' },
  };
  it('propagates database failures instead of treating them as missing orders', async () => {
    const service = new PaymentRecoveryService(
      {
        getOrder: vi.fn().mockRejectedValue(new Error('database unavailable')),
      } as unknown as OrderService,
      null,
    );
    await expect(service.handleFailedPayment('order')).rejects.toThrow('database unavailable');
    const missing = new PaymentRecoveryService(
      {
        getOrder: vi.fn().mockRejectedValue(new OrderNotFoundError('missing')),
      } as unknown as OrderService,
      null,
    );
    await expect(missing.handleFailedPayment('missing')).resolves.toBeUndefined();
  });
  it('reserves a persistent attempt before delivery and supplies its stable idempotency key', async () => {
    const events: string[] = [];
    let count = 0;
    const attempts: RecoveryAttemptStore = {
      claim: vi.fn(async (_id, max, _at) => {
        if (count >= max) return null;
        events.push('claim');
        return { attemptNumber: ++count };
      }),
      get: vi.fn(async () => ({ count, lastAt: new Date() })),
    };
    const sendRecoveryEmail = vi.fn(async () => {
      events.push('send');
    });
    const orders = { getOrder: vi.fn().mockResolvedValue(failed) } as unknown as OrderService;
    const first = new PaymentRecoveryService(orders, attempts, { sendRecoveryEmail });
    first.configure({ maxAttempts: 1 });
    await first.handleFailedPayment('order');
    const restarted = new PaymentRecoveryService(orders, attempts, { sendRecoveryEmail });
    restarted.configure({ maxAttempts: 1 });
    await restarted.handleFailedPayment('order');
    expect(events).toEqual(['claim', 'send']);
    expect(sendRecoveryEmail).toHaveBeenCalledOnce();
    expect(sendRecoveryEmail).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'payment-recovery:order:1' }),
    );
  });
  it('does not pretend an attempt succeeded without a sender or persistence', async () => {
    const orders = { getOrder: vi.fn().mockResolvedValue(failed) } as unknown as OrderService;
    const claim = vi.fn();
    await new PaymentRecoveryService(orders, { claim, get: vi.fn() }).handleFailedPayment('order');
    expect(claim).not.toHaveBeenCalled();
    await expect(
      new PaymentRecoveryService(orders, null, { sendRecoveryEmail: vi.fn() }).handleFailedPayment(
        'order',
      ),
    ).rejects.toThrow('persistence');
  });
});
