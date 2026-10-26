import {
  OrderService,
  OrderNotFoundError,
  type Order,
  type CreateOrderParams,
} from './order.service';
import { PaymentProviderRegistry } from './contract/registry';
import { createFakeAdapter } from './contract/fake-adapter';
import type { OrderPersistence } from './order-persistence';
import type { PaymentSession } from './contract/payment-contract';
import type { SettlementState } from './contract/settlement';

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
/**
 * 用参考适配器组一个注册表。
 * 旧版本这里手搓了一个 { createPaymentIntent, confirmPayment, refund } 的假对象——
 * 它不实现任何真实契约，测出来的"通过"证明不了适配器会怎么表现。
 * 现在用 createFakeAdapter，它本身受契约套件约束。
 */
function payments(id = 'test') {
  const { adapter } = createFakeAdapter({ id });
  const spied = {
    ...adapter,
    createPayment: vi.fn(adapter.createPayment),
    capture: vi.fn(adapter.capture),
    retrieve: vi.fn(adapter.retrieve),
    refund: vi.fn(adapter.refund),
  };
  return { registry: new PaymentProviderRegistry([spied]), adapter: spied };
}
/** 契约形状的 capture 结果；旧写法 { id, status } 不会被 confirmOrder 读到 state。 */
function capturedAs(state: SettlementState): PaymentSession {
  return {
    providerRef: 'payment-1',
    nextAction: { kind: 'none' },
    state,
    money: params.payment.money,
  };
}
const params: CreateOrderParams = {
  orderId: 'order-1',
  providerId: 'test',
  payment: {
    reference: 'order-1',
    money: { amount: '10.00', currency: 'USD' },
    idempotencyKey: 'order-1:create',
  },
};

describe('persistent order workflow', () => {
  it('requires an explicit persistence port', () => {
    expect(() => new OrderService(payments().registry, undefined as never)).toThrow('persistence');
  });
  it('reads existing state through a new service and cannot mutate storage through returned references', async () => {
    const rows = new Map<string, Order>();
    const payment = payments();
    await new OrderService(payment.registry, persistence(rows)).createOrder(params);
    const restarted = new OrderService(payment.registry, persistence(rows));
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
    await expect(new OrderService(payment.registry, store).createOrder(params)).rejects.toThrow(
      'database unavailable',
    );
    expect(payment.adapter.createPayment).not.toHaveBeenCalled();
  });
  it('allows only one simultaneous confirmation and one simultaneous refund', async () => {
    const payment = payments();
    const store = persistence(new Map());
    const first = new OrderService(payment.registry, store);
    const second = new OrderService(payment.registry, store);
    await first.createOrder(params);
    const confirmed = await Promise.allSettled([
      first.confirmOrder(params.orderId, 'k-capture'),
      second.confirmOrder(params.orderId, 'k-capture'),
    ]);
    expect(confirmed.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(payment.adapter.capture).toHaveBeenCalledOnce();
    await Promise.allSettled([
      first.refundOrder(params.orderId, 'k-refund'),
      second.refundOrder(params.orderId, 'k-refund'),
    ]);
    expect(payment.adapter.refund).toHaveBeenCalledOnce();
  });
  it('retains unknown provider outcomes for reconciliation without automatic repeated attempts', async () => {
    const payment = payments();
    const service = new OrderService(payment.registry, persistence(new Map()));
    payment.adapter.createPayment.mockRejectedValueOnce(new Error('connection lost'));
    await expect(service.createOrder(params)).rejects.toThrow('connection lost');
    expect((await service.getOrder(params.orderId)).status).toBe('created');
    await expect(service.retryOrder(params.orderId, 'k-retry')).rejects.toThrow('状态已变化');
    expect(payment.adapter.createPayment).toHaveBeenCalledOnce();
  });

  it.each(['created', 'authorized', 'unknown'] as const)(
    'does not reopen confirmation after a %s response',
    async (state) => {
      const payment = payments();
      payment.adapter.capture.mockResolvedValue(capturedAs(state));
      const service = new OrderService(payment.registry, persistence(new Map()));
      await service.createOrder(params);
      await expect(service.confirmOrder(params.orderId, 'k-capture')).resolves.toMatchObject({
        state,
      });
      expect((await service.getOrder(params.orderId)).status).toBe('confirming');
      await expect(service.confirmOrder(params.orderId, 'k-capture')).rejects.toThrow('状态已变化');
      expect(payment.adapter.capture).toHaveBeenCalledOnce();
    },
  );

  it('retains a refunded confirmation result as a terminal order', async () => {
    const payment = payments();
    payment.adapter.capture.mockResolvedValue(capturedAs('refunded'));
    const service = new OrderService(payment.registry, persistence(new Map()));
    await service.createOrder(params);
    await service.confirmOrder(params.orderId, 'k-capture');
    expect((await service.getOrder(params.orderId)).status).toBe('refunded');
    await expect(service.confirmOrder(params.orderId, 'k-capture')).rejects.toThrow('状态已变化');
    expect(payment.adapter.capture).toHaveBeenCalledOnce();
  });
  it('does not return an uncommitted provider link as a successfully saved payment', async () => {
    const store = persistence(new Map());
    const payment = payments();
    vi.mocked(store.compareAndSet).mockRejectedValueOnce(new Error('write failed'));
    const service = new OrderService(payment.registry, store);
    await expect(service.createOrder(params)).rejects.toThrow('write failed');
    expect((await service.getOrder(params.orderId)).status).toBe('created');
    expect(payment.adapter.createPayment).toHaveBeenCalledOnce();
  });
});

describe('legacy partial-refund boundary', () => {
  function paid(amount = '10.00', currency = 'USD') {
    const payment = payments(),
      rows = new Map<string, Order>();
    rows.set('paid-order', {
      id: 'paid-order',
      providerId: 'test',
      paymentIntentId: 'payment-1',
      paymentId: 'payment-1',
      amount,
      currency,
      status: 'paid',
      createdAt: new Date(),
      updatedAt: new Date(),
      paidAt: new Date(),
    });
    const store = persistence(rows),
      service = new OrderService(payment.registry, store);
    return { payment, rows, store, service };
  }
  it('does not turn a completed partial refund into a fully refunded order or guess cumulative totals', async () => {
    const { payment, store, service } = paid();
    payment.adapter.refund.mockResolvedValue({ refundRef: 'refund-1', state: 'refunded' });
    const result = await service.refundOrder('paid-order', 'partial-1', {
      money: { amount: '4.00', currency: 'USD' },
    });
    expect(result).toEqual({ refundRef: 'refund-1', state: 'partially_refunded' });
    expect(await service.getOrder('paid-order')).toMatchObject({ status: 'paid' });
    expect((await service.getOrder('paid-order')).refundedAt).toBeUndefined();
    const restarted = new OrderService(payment.registry, store);
    await expect(
      restarted.refundOrder('paid-order', 'partial-2', {
        money: { amount: '6.00', currency: 'USD' },
      }),
    ).resolves.toMatchObject({ state: 'partially_refunded' });
    expect((await restarted.getOrder('paid-order')).status).toBe('paid');
    expect(payment.adapter.refund).toHaveBeenNthCalledWith(2, {
      providerRef: 'payment-1',
      money: { amount: '6.00', currency: 'USD' },
      reason: undefined,
      idempotencyKey: 'partial-2',
    });
  });
  it('preserves a provider partial observation without storing the full-refund terminal state', async () => {
    const { payment, service } = paid();
    payment.adapter.refund.mockResolvedValue({
      refundRef: 'refund-partial',
      state: 'partially_refunded',
    });
    await expect(service.refundOrder('paid-order', 'observed')).resolves.toMatchObject({
      state: 'partially_refunded',
    });
    expect((await service.getOrder('paid-order')).status).toBe('paid');
    expect((await service.getOrder('paid-order')).refundedAt).toBeUndefined();
  });
  it.each([undefined, { amount: '0010.000', currency: 'USD' }])(
    'retains explicit whole-payment refund semantics for %j',
    async (money) => {
      const { payment, service } = paid();
      payment.adapter.refund.mockResolvedValue({ refundRef: 'full', state: 'refunded' });
      await expect(service.refundOrder('paid-order', 'full', { money })).resolves.toMatchObject({
        state: 'refunded',
      });
      expect(await service.getOrder('paid-order')).toMatchObject({
        status: 'refunded',
        refundedAt: expect.any(Date),
      });
    },
  );
  it.each([
    { amount: '1.00', currency: 'EUR' },
    { amount: '0.00', currency: 'USD' },
    { amount: '-1.00', currency: 'USD' },
    { amount: '10.0001', currency: 'USD' },
    { amount: '1e1', currency: 'USD' },
    { amount: 'NaN', currency: 'USD' },
    { amount: 5, currency: 'USD' },
    null,
  ])('rejects invalid refund %j before CAS or any provider request', async (money) => {
    const { payment, store, service } = paid();
    await expect(
      service.refundOrder('paid-order', 'invalid', { money: money as never }),
    ).rejects.toThrow();
    expect(store.compareAndSet).not.toHaveBeenCalled();
    expect(payment.adapter.refund).not.toHaveBeenCalled();
    expect((await service.getOrder('paid-order')).status).toBe('paid');
  });
  it('compares large and multi-decimal amounts without a floating-point or two-decimal conversion', async () => {
    const { payment, service } = paid('9007199254740993.003', 'KWD');
    payment.adapter.refund.mockResolvedValue({ refundRef: 'precise', state: 'refunded' });
    await expect(
      service.refundOrder('paid-order', 'precise', {
        money: { amount: '9007199254740993.002', currency: 'KWD' },
      }),
    ).resolves.toMatchObject({ state: 'partially_refunded' });
    await expect(
      service.refundOrder('paid-order', 'too-large', {
        money: { amount: '9007199254740993.004', currency: 'KWD' },
      }),
    ).rejects.toThrow('exceed');
    expect(payment.adapter.refund).toHaveBeenCalledOnce();
  });
  it('keeps an uncertain partial attempt in flight without retry and restores paid only on definite failure', async () => {
    const { payment, service } = paid();
    payment.adapter.refund.mockResolvedValue({ refundRef: 'pending', state: 'unknown' });
    await service.refundOrder('paid-order', 'pending', {
      money: { amount: '2.00', currency: 'USD' },
    });
    expect((await service.getOrder('paid-order')).status).toBe('refunding');
    await expect(
      service.refundOrder('paid-order', 'pending', { money: { amount: '2.00', currency: 'USD' } }),
    ).rejects.toThrow('状态已变化');
    expect(payment.adapter.refund).toHaveBeenCalledOnce();
    const failed = paid();
    failed.payment.adapter.refund.mockResolvedValue({ refundRef: 'failed', state: 'failed' });
    await failed.service.refundOrder('paid-order', 'failed', {
      money: { amount: '2.00', currency: 'USD' },
    });
    expect((await failed.service.getOrder('paid-order')).status).toBe('paid');
  });
  it('keeps a partially refunded capture observation nonterminal and retains its refund reference', async () => {
    const payment = payments(),
      service = new OrderService(payment.registry, persistence(new Map()));
    payment.adapter.capture.mockResolvedValue(capturedAs('partially_refunded'));
    await service.createOrder(params);
    await service.confirmOrder(params.orderId, 'capture');
    expect(await service.getOrder(params.orderId)).toMatchObject({
      status: 'paid',
      paymentId: 'payment-1',
    });
    expect((await service.getOrder(params.orderId)).refundedAt).toBeUndefined();
  });
});
