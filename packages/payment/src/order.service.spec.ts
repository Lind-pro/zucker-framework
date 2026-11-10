import {
  OrderService,
  OrderNotFoundError,
  PARTIAL_REFUND_COUNT_KEY,
  PENDING_REFUND_KEY,
  partialRefundCount,
  pendingRefund,
  type Order,
  type CreateOrderParams,
} from './order.service';
import { PaymentProviderRegistry } from './contract/registry';
import { createFakeAdapter } from './contract/fake-adapter';
import type { OrderPersistence } from './order-persistence';
import type { PaymentSession } from './contract/payment-contract';
import type { SettlementState } from './contract/settlement';
import { PaymentRejectedError } from './contract/rejection';

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

  it('does not reopen confirmation after an unknown response', async () => {
    const payment = payments();
    payment.adapter.capture.mockResolvedValue(capturedAs('unknown'));
    const service = new OrderService(payment.registry, persistence(new Map()));
    await service.createOrder(params);
    await expect(service.confirmOrder(params.orderId, 'k-capture')).resolves.toMatchObject({ state: 'unknown' });
    expect((await service.getOrder(params.orderId)).status).toBe('confirming');
    await expect(service.confirmOrder(params.orderId, 'k-capture')).rejects.toThrow('状态已变化');
    expect(payment.adapter.capture).toHaveBeenCalledOnce();
  });

  it.each(['created', 'authorized'] as const)(
    'reopens confirmation after a known %s (not yet paid) response (M2)',
    async (state) => {
      const payment = payments();
      payment.adapter.capture.mockResolvedValue(capturedAs(state));
      const service = new OrderService(payment.registry, persistence(new Map()));
      await service.createOrder(params);
      await service.confirmOrder(params.orderId, 'k-capture');
      expect((await service.getOrder(params.orderId)).status).toBe('paying');
      payment.adapter.capture.mockResolvedValue(capturedAs('captured'));
      await service.confirmOrder(params.orderId, 'k-capture-2');
      expect((await service.getOrder(params.orderId)).status).toBe('paid');
    },
  );

  it('returns a definitely rejected capture to paying and keeps unknown failures confirming (M2)', async () => {
    const payment = payments();
    const service = new OrderService(payment.registry, persistence(new Map()));
    await service.createOrder(params);
    payment.adapter.capture.mockRejectedValueOnce(Object.assign(new Error('ORDER_NOT_APPROVED'), { statusCode: 422 }));
    await expect(service.confirmOrder(params.orderId, 'k1')).rejects.toThrow('ORDER_NOT_APPROVED');
    expect((await service.getOrder(params.orderId)).status).toBe('paying');
    payment.adapter.capture.mockRejectedValueOnce(new Error('socket hang up'));
    await expect(service.confirmOrder(params.orderId, 'k2')).rejects.toThrow('socket hang up');
    expect((await service.getOrder(params.orderId)).status).toBe('confirming');
  });

  it('reconciles a parked confirmation read-only through retrieve (M2)', async () => {
    const payment = payments();
    const service = new OrderService(payment.registry, persistence(new Map()));
    await service.createOrder(params);
    payment.adapter.capture.mockRejectedValueOnce(new Error('timeout'));
    await expect(service.confirmOrder(params.orderId, 'k1')).rejects.toThrow('timeout');
    payment.adapter.retrieve.mockResolvedValueOnce(capturedAs('created'));
    expect((await service.reconcileOrder(params.orderId)).status).toBe('paying');
    payment.adapter.capture.mockRejectedValueOnce(new Error('timeout'));
    await expect(service.confirmOrder(params.orderId, 'k2')).rejects.toThrow('timeout');
    payment.adapter.retrieve.mockResolvedValueOnce(capturedAs('captured'));
    expect(await service.reconcileOrder(params.orderId)).toMatchObject({ status: 'paid', paymentId: 'payment-1' });
    expect(payment.adapter.capture).toHaveBeenCalledTimes(2);
  });

  it('resolves a parked refund only from refund evidence or an explicit operator decision (M2)', async () => {
    const payment = payments();
    const service = new OrderService(payment.registry, persistence(new Map()));
    await service.createOrder(params);
    payment.adapter.capture.mockResolvedValueOnce(capturedAs('captured'));
    await service.confirmOrder(params.orderId, 'k-capture');
    payment.adapter.refund.mockRejectedValueOnce(new Error('timeout'));
    await expect(service.refundOrder(params.orderId, 'r1')).rejects.toThrow('timeout');
    payment.adapter.retrieve.mockResolvedValueOnce(capturedAs('captured'));
    expect((await service.reconcileOrder(params.orderId)).status).toBe('refunding');
    payment.adapter.retrieve.mockResolvedValueOnce(capturedAs('refunded'));
    expect((await service.reconcileOrder(params.orderId)).status).toBe('refunded');
    expect(payment.adapter.refund).toHaveBeenCalledOnce();
  });

  it('returns a definitely rejected refund to paid (M2)', async () => {
    const payment = payments();
    const service = new OrderService(payment.registry, persistence(new Map()));
    await service.createOrder(params);
    payment.adapter.capture.mockResolvedValueOnce(capturedAs('captured'));
    await service.confirmOrder(params.orderId, 'k-capture');
    payment.adapter.refund.mockRejectedValueOnce(new PaymentRejectedError('charge already refunded', 400));
    // N3: the rejection is only released after a read shows nothing was refunded.
    payment.adapter.retrieve.mockResolvedValueOnce(capturedAs('captured'));
    await expect(service.refundOrder(params.orderId, 'r1')).rejects.toThrow('already refunded');
    expect((await service.getOrder(params.orderId)).status).toBe('paid');
    payment.adapter.refund.mockRejectedValueOnce(new Error('timeout'));
    await expect(service.refundOrder(params.orderId, 'r2')).rejects.toThrow('timeout');
    expect((await service.resolveRefund(params.orderId, 'not_refunded')).status).toBe('paid');
  });

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

describe('refund bookkeeping and rejected-call reconciliation (N2, N3)', () => {
  function paidOrder(metadata?: Record<string, string>) {
    const payment = payments(),
      rows = new Map<string, Order>();
    rows.set('paid-order', {
      id: 'paid-order',
      providerId: 'test',
      paymentIntentId: 'payment-1',
      paymentId: 'payment-1',
      amount: '10.00',
      currency: 'USD',
      status: 'paid',
      createdAt: new Date(),
      updatedAt: new Date(),
      paidAt: new Date(),
      ...(metadata ? { metadata } : {}),
    });
    return { payment, rows, service: new OrderService(payment.registry, persistence(rows)) };
  }
  const partialMoney = { money: { amount: '4.00', currency: 'USD' } };
  const stuckRefund = async (h: ReturnType<typeof paidOrder>) => {
    h.payment.adapter.refund.mockRejectedValueOnce(new Error('connection lost'));
    await expect(h.service.refundOrder('paid-order', 'r-unknown', partialMoney)).rejects.toThrow('connection lost');
    expect((await h.service.getOrder('paid-order')).status).toBe('refunding');
  };

  it('N2: a first partial refund with an unknown outcome reconciles to paid and counts one partial', async () => {
    const h = paidOrder();
    await stuckRefund(h);
    expect(pendingRefund(await h.service.getOrder('paid-order'))).toMatchObject({ idempotencyKey: 'r-unknown', amount: '4.00', hadPriorPartial: false });
    h.payment.adapter.retrieve.mockResolvedValueOnce(capturedAs('partially_refunded'));
    const order = await h.service.reconcileOrder('paid-order');
    expect(order.status).toBe('paid');
    expect(partialRefundCount(order)).toBe(1);
    expect(pendingRefund(order)).toBeUndefined();
  });

  it('N2: with an earlier recorded partial, the same observation leaves the order refunding', async () => {
    const h = paidOrder({ [PARTIAL_REFUND_COUNT_KEY]: '1' });
    await stuckRefund(h);
    h.payment.adapter.retrieve.mockResolvedValueOnce(capturedAs('partially_refunded'));
    const order = await h.service.reconcileOrder('paid-order');
    expect(order.status).toBe('refunding');
    expect(partialRefundCount(order)).toBe(1);
    expect(pendingRefund(order)).toBeDefined();
  });

  it.each([undefined, { [PARTIAL_REFUND_COUNT_KEY]: '2' }])('N2: a refunded observation always gives refunded (prior %j)', async (metadata) => {
    const h = paidOrder(metadata);
    await stuckRefund(h);
    h.payment.adapter.retrieve.mockResolvedValueOnce(capturedAs('refunded'));
    const order = await h.service.reconcileOrder('paid-order');
    expect(order.status).toBe('refunded');
    expect(order.refundedAt).toBeInstanceOf(Date);
    expect(pendingRefund(order)).toBeUndefined();
  });

  it('N2: resolveRefund clears the pending marker and only partially_refunded increments the count', async () => {
    const notRefunded = paidOrder();
    await stuckRefund(notRefunded);
    expect(pendingRefund(await notRefunded.service.getOrder('paid-order'))).toBeDefined();
    const back = await notRefunded.service.resolveRefund('paid-order', 'not_refunded');
    expect(back.status).toBe('paid');
    expect(pendingRefund(back)).toBeUndefined();
    expect(partialRefundCount(back)).toBe(0);

    const partial = paidOrder();
    await stuckRefund(partial);
    const resolved = await partial.service.resolveRefund('paid-order', 'partially_refunded');
    expect(resolved.status).toBe('paid');
    expect(pendingRefund(resolved)).toBeUndefined();
    expect(partialRefundCount(resolved)).toBe(1);

    const full = paidOrder();
    await stuckRefund(full);
    const refunded = await full.service.resolveRefund('paid-order', 'refunded');
    expect(refunded.status).toBe('refunded');
    expect(pendingRefund(refunded)).toBeUndefined();
  });

  it('N2: retryOrder does not pass the zucker.* bookkeeping keys to the provider', async () => {
    const payment = payments();
    const rows = new Map<string, Order>();
    rows.set('failed-order', {
      id: 'failed-order',
      providerId: 'test',
      amount: '10.00',
      currency: 'USD',
      status: 'failed',
      createdAt: new Date(),
      updatedAt: new Date(),
      metadata: {
        plan: 'pro',
        [PENDING_REFUND_KEY]: JSON.stringify({ idempotencyKey: 'x', amount: '1.00', currency: 'USD', hadPriorPartial: false }),
        [PARTIAL_REFUND_COUNT_KEY]: '2',
      },
    });
    await new OrderService(payment.registry, persistence(rows)).retryOrder('failed-order', 'retry-key');
    expect(payment.adapter.createPayment).toHaveBeenCalledOnce();
    const input = payment.adapter.createPayment.mock.calls[0][0];
    expect(input.metadata).toEqual({ plan: 'pro' });
    expect(Object.keys(input.metadata ?? {}).some((key) => key.startsWith('zucker.'))).toBe(false);
  });

  describe('N3 capture rejected with 4xx', () => {
    const rejection = () => new PaymentRejectedError('ORDER_ALREADY_CAPTURED', 422);
    const cases: Array<[string, SettlementState | 'throws', string]> = [
      ['captured', 'captured', 'paid'],
      ['created', 'created', 'paying'],
      ['unknown', 'unknown', 'confirming'],
      ['retrieve throws', 'throws', 'confirming'],
    ];
    it.each(cases)('retrieve %s leaves the order %s-> %#', async (_name, observed, expected) => {
      const payment = payments();
      const service = new OrderService(payment.registry, persistence(new Map()));
      await service.createOrder(params);
      const error = rejection();
      payment.adapter.capture.mockRejectedValueOnce(error);
      if (observed === 'throws') payment.adapter.retrieve.mockRejectedValueOnce(new Error('network'));
      else payment.adapter.retrieve.mockResolvedValueOnce(capturedAs(observed));
      await expect(service.confirmOrder(params.orderId, 'k')).rejects.toBe(error);
      expect((await service.getOrder(params.orderId)).status).toBe(expected);
    });
  });

  describe('N3 refund rejected with 4xx', () => {
    const rejection = () => new PaymentRejectedError('refund rejected', 400);
    const cases: Array<[string, SettlementState | 'throws', Record<string, string> | undefined, string]> = [
      ['refunded', 'refunded', undefined, 'refunded'],
      ['captured', 'captured', undefined, 'paid'],
      ['partially_refunded without a prior partial', 'partially_refunded', undefined, 'refunding'],
      ['partially_refunded with a prior partial', 'partially_refunded', { [PARTIAL_REFUND_COUNT_KEY]: '1' }, 'paid'],
      ['unknown', 'unknown', undefined, 'refunding'],
      ['retrieve throws', 'throws', undefined, 'refunding'],
    ];
    it.each(cases)('retrieve %s -> %s', async (_name, observed, metadata, expected) => {
      const h = paidOrder(metadata);
      const error = rejection();
      h.payment.adapter.refund.mockRejectedValueOnce(error);
      if (observed === 'throws') h.payment.adapter.retrieve.mockRejectedValueOnce(new Error('network'));
      else h.payment.adapter.retrieve.mockResolvedValueOnce(capturedAs(observed));
      await expect(h.service.refundOrder('paid-order', 'r1')).rejects.toBe(error);
      expect((await h.service.getOrder('paid-order')).status).toBe(expected);
    });
  });
});
