import {
  OrderService,
  OrderNotFoundError,
  type Order,
  type CreateOrderParams,
} from './order.service';
import { PaymentService } from './payment.service';
import type { OrderPersistence } from './order-persistence';

/** A port-level fake, not evidence of database isolation or restart durability. */
function persistence(rows: Map<string, Order>): OrderPersistence<Order> {
  return {
    create: vi.fn(async ({ data }) => {
      const row = data as Order;
      if (rows.has(row.id)) throw new Error('duplicate id');
      rows.set(row.id, structuredClone(row));
      return structuredClone(row);
    }),
    findUnique: vi.fn(async ({ where }) =>
      structuredClone(rows.get((where as { id: string }).id) ?? null),
    ),
    findMany: vi.fn(async () => structuredClone([...rows.values()])),
    count: vi.fn(async () => rows.size),
    update: vi.fn(),
    updateMany: vi.fn(),
    compareAndSet: vi.fn(async (id, expected, data) => {
      const row = rows.get(id);
      if (!row || !(expected.status as { in: string[] }).in.includes(row.status)) return false;
      rows.set(id, { ...row, ...data } as Order);
      return true;
    }),
  };
}
function payments() {
  return {
    createPaymentIntent: vi.fn().mockResolvedValue({ id: 'intent-1' }),
    confirmPayment: vi.fn().mockResolvedValue({ id: 'payment-1', status: 'succeeded' }),
    refund: vi.fn().mockResolvedValue({ id: 'refund-1', status: 'succeeded' }),
  };
}
const params: CreateOrderParams = {
  orderId: 'order-1',
  providerId: 'test',
  payment: { amount: 1000, currency: 'USD' },
};

describe('persistent order workflow', () => {
  it('requires an explicit persistence port', () => {
    expect(
      () => new OrderService(payments() as unknown as PaymentService, undefined as never),
    ).toThrow('persistence');
  });
  it('reads existing state through a new service and cannot mutate storage through returned references', async () => {
    const rows = new Map<string, Order>();
    const payment = payments();
    await new OrderService(payment as unknown as PaymentService, persistence(rows)).createOrder(
      params,
    );
    const restarted = new OrderService(payment as unknown as PaymentService, persistence(rows));
    const row = await restarted.getOrder(params.orderId);
    expect(row.status).toBe('paying');
    row.status = 'cancelled';
    expect((await restarted.getOrder(params.orderId)).status).toBe('paying');
    await expect(restarted.getOrder('missing')).rejects.toBeInstanceOf(OrderNotFoundError);
  });
  it('never contacts a provider when persisting the order fails', async () => {
    const store = persistence(new Map());
    const payment = payments();
    vi.mocked(store.create).mockRejectedValueOnce(new Error('database unavailable'));
    await expect(
      new OrderService(payment as unknown as PaymentService, store).createOrder(params),
    ).rejects.toThrow('database unavailable');
    expect(payment.createPaymentIntent).not.toHaveBeenCalled();
  });
  it('allows only one simultaneous confirmation and one simultaneous refund', async () => {
    const payment = payments();
    const store = persistence(new Map());
    const first = new OrderService(payment as unknown as PaymentService, store);
    const second = new OrderService(payment as unknown as PaymentService, store);
    await first.createOrder(params);
    const confirmed = await Promise.allSettled([
      first.confirmOrder(params.orderId),
      second.confirmOrder(params.orderId),
    ]);
    expect(confirmed.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(payment.confirmPayment).toHaveBeenCalledOnce();
    await Promise.allSettled([
      first.refundOrder(params.orderId),
      second.refundOrder(params.orderId),
    ]);
    expect(payment.refund).toHaveBeenCalledOnce();
  });
  it('retains unknown provider outcomes for reconciliation without automatic repeated attempts', async () => {
    const payment = payments();
    const service = new OrderService(payment as unknown as PaymentService, persistence(new Map()));
    payment.createPaymentIntent.mockRejectedValueOnce(new Error('connection lost'));
    await expect(service.createOrder(params)).rejects.toThrow('connection lost');
    expect((await service.getOrder(params.orderId)).status).toBe('created');
    await expect(service.retryOrder(params.orderId)).rejects.toThrow('状态已变化');
    expect(payment.createPaymentIntent).toHaveBeenCalledOnce();
  });

  it.each(['pending', 'processing'])(
    'does not reopen confirmation after a %s response',
    async (status) => {
      const payment = payments();
      payment.confirmPayment.mockResolvedValue({ id: 'payment-1', status });
      const service = new OrderService(
        payment as unknown as PaymentService,
        persistence(new Map()),
      );
      await service.createOrder(params);
      await expect(service.confirmOrder(params.orderId)).resolves.toMatchObject({ status });
      expect((await service.getOrder(params.orderId)).status).toBe('confirming');
      await expect(service.confirmOrder(params.orderId)).rejects.toThrow('状态已变化');
      expect(payment.confirmPayment).toHaveBeenCalledOnce();
    },
  );

  it('retains a refunded confirmation result as a terminal order', async () => {
    const payment = payments();
    payment.confirmPayment.mockResolvedValue({ id: 'payment-1', status: 'refunded' });
    const service = new OrderService(payment as unknown as PaymentService, persistence(new Map()));
    await service.createOrder(params);
    await service.confirmOrder(params.orderId);
    expect((await service.getOrder(params.orderId)).status).toBe('refunded');
    await expect(service.confirmOrder(params.orderId)).rejects.toThrow('状态已变化');
    expect(payment.confirmPayment).toHaveBeenCalledOnce();
  });
  it('does not return an uncommitted provider link as a successfully saved payment', async () => {
    const store = persistence(new Map());
    const payment = payments();
    vi.mocked(store.compareAndSet).mockRejectedValueOnce(new Error('write failed'));
    const service = new OrderService(payment as unknown as PaymentService, store);
    await expect(service.createOrder(params)).rejects.toThrow('write failed');
    expect((await service.getOrder(params.orderId)).status).toBe('created');
    expect(payment.createPaymentIntent).toHaveBeenCalledOnce();
  });
});
