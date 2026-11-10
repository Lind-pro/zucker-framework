import { Injectable, Inject } from '@nestjs/common';
import { PaymentProviderRegistry } from './contract/registry';
import type { CreatePaymentInput, PaymentSession } from './contract/payment-contract';
import { reconcile, type SettlementState } from './contract/settlement';
import { isDefinitePaymentRejection } from './contract/rejection';
import { ORDER_PERSISTENCE, type OrderPersistence } from './order-persistence';

export type OrderStatus =
  'created' | 'paying' | 'confirming' | 'paid' | 'failed' | 'refunding' | 'refunded' | 'cancelled';
export interface Order {
  id: string;
  providerId: string;
  paymentIntentId?: string;
  paymentId?: string;
  /**
   * 十进制字符串，与 Money.amount 同一表示。
   * 原先是 number：一旦金额在 number 与字符串之间来回转换，"29.00" 会变成 29，
   * 三位小数币种会被静默截断。整条链路只保留一种表示。
   */
  amount: string;
  currency: string;
  status: OrderStatus;
  metadata?: Record<string, string>;
  createdAt: Date;
  updatedAt: Date;
  paidAt?: Date;
  refundedAt?: Date;
}
export interface CreateOrderParams {
  orderId: string;
  providerId: string;
  payment: CreatePaymentInput;
}

export class OrderNotFoundError extends Error {
  constructor(readonly orderId: string) {
    super(`订单 "${orderId}" 不存在`);
    this.name = 'OrderNotFoundError';
  }
}

/** Durable provider workflow. External calls never run inside a database transaction here. */
@Injectable()
export class OrderService {
  constructor(
    private readonly providers: PaymentProviderRegistry,
    @Inject(ORDER_PERSISTENCE) private readonly orders: OrderPersistence<Order>,
  ) {
    if (!orders) throw new Error('Order persistence must be configured');
  }

  async createOrder(params: CreateOrderParams): Promise<Order> {
    if (await this.orders.findUnique({ where: { id: params.orderId } })) {
      throw new Error(`订单 "${params.orderId}" 已存在`);
    }
    const now = new Date();
    // The database must enforce id uniqueness; concurrent creators cannot both call the provider.
    const order = await this.orders.create({
      data: {
        id: params.orderId,
        providerId: params.providerId,
        amount: params.payment.money.amount,
        currency: params.payment.money.currency,
        metadata: params.payment.metadata,
        status: 'created',
        createdAt: now,
        updatedAt: now,
      },
    });
    return this.initiatePayment(order, params.payment);
  }

  private async initiatePayment(order: Order, payment: CreatePaymentInput): Promise<Order> {
    // Unknown provider outcomes remain created for reconciliation; never automatically re-charge.
    let session: PaymentSession;
    try {
      session = await this.providers.get(order.providerId).createPayment(payment);
    } catch (error) {
      // A definite rejection created nothing at the provider: mark failed so retryOrder/cancelOrder apply.
      if (isDefinitePaymentRejection(error)) await this.transition(order.id, ['created'], 'failed').catch(() => undefined);
      throw error;
    }
    await this.transition(order.id, ['created'], 'paying', {
      paymentIntentId: session.providerRef,
    });
    return this.getOrder(order.id);
  }

  /**
   * 扣款。幂等键由调用方给出——同一笔订单重试必须复用同一个键，否则渠道会认为是新支付。
   * 判定不了的结果保持 confirming，交由只读对账解决，绝不在这里重复扣款。
   */
  async confirmOrder(orderId: string, idempotencyKey: string): Promise<PaymentSession> {
    const order = await this.getOrder(orderId);
    if (!order.paymentIntentId) throw new Error(`订单 "${orderId}" 缺少 paymentIntentId`);
    await this.transition(orderId, ['paying'], 'confirming');
    let session: PaymentSession;
    try {
      session = await this.providers
        .get(order.providerId)
        .capture(order.paymentIntentId, idempotencyKey);
    } catch (error) {
      // e.g. PayPal 422 ORDER_NOT_APPROVED: nothing was captured, the buyer can still pay.
      if (isDefinitePaymentRejection(error)) await this.transition(orderId, ['confirming'], 'paying');
      throw error;
    }
    await this.applySettlement(orderId, 'confirming', session.state, session.providerRef);
    if (session.state === 'created' || session.state === 'authorized') {
      // A known "not paid yet" answer is not an unknown outcome: reopen confirmation.
      await this.transition(orderId, ['confirming'], 'paying');
    }
    return session;
  }

  /**
   * Read-only reconciliation for orders parked in `paying`, `confirming` or `refunding`.
   * Calls `adapter.retrieve` only (never capture/refund) and applies the observation with the
   * same `reconcile()` rules. Use it from a return page, a webhook handler or a periodic job.
   *
   * A `refunding` order only leaves that state on refund evidence (`refunded` /
   * `partially_refunded`). Adapters whose `retrieve` cannot observe refunds (the legacy Stripe
   * Checkout adapter) keep it `refunding`; resolve those with `resolveRefund` after checking the
   * provider.
   */
  async reconcileOrder(orderId: string): Promise<Order> {
    const order = await this.getOrder(orderId);
    const refunding = order.status === 'refunding';
    const ref = refunding ? order.paymentId : order.paymentIntentId;
    if (!ref || !['paying', 'confirming', 'refunding'].includes(order.status)) return order;
    const session = await this.providers.get(order.providerId).retrieve(ref);
    if (refunding) {
      if (session.state === 'refunded') {
        await this.transition(orderId, ['refunding'], 'refunded', { refundedAt: new Date() });
      } else if (session.state === 'partially_refunded') {
        await this.transition(orderId, ['refunding'], 'paid');
      }
      return this.getOrder(orderId);
    }
    await this.applySettlement(orderId, order.status, session.state, session.providerRef);
    if (order.status === 'confirming' && (session.state === 'created' || session.state === 'authorized')) {
      await this.transition(orderId, ['confirming'], 'paying');
    }
    return this.getOrder(orderId);
  }

  /**
   * Operator escape hatch for a `refunding` order whose outcome was verified out of band
   * (provider dashboard / refund API). `not_refunded` returns it to `paid`; `refunded` and
   * `partially_refunded` record the verified result. Never call this on a guess: returning a
   * refunded order to `paid` lets it be refunded again.
   */
  async resolveRefund(orderId: string, outcome: 'refunded' | 'partially_refunded' | 'not_refunded'): Promise<Order> {
    if (outcome === 'refunded') await this.transition(orderId, ['refunding'], 'refunded', { refundedAt: new Date() });
    else await this.transition(orderId, ['refunding'], 'paid');
    return this.getOrder(orderId);
  }

  /**
   * 把渠道观察到的结算状态落到订单上。
   * 迁移是否允许由 reconcile() 统一裁决，保证所有渠道遵守同一套安全性质
   * （unknown 不覆盖已知状态、已收款不被迟到的失败回调回退）。
   */
  private async applySettlement(
    orderId: string,
    from: Order['status'],
    observed: SettlementState,
    paymentRef?: string,
  ): Promise<void> {
    const current: SettlementState =
      from === 'paid' ? 'captured' : from === 'refunded' ? 'refunded' : 'created';
    const decision = reconcile(current, observed);
    if (!decision.changed) return;
    if (decision.next === 'captured') {
      await this.transition(orderId, [from], 'paid', {
        paymentId: paymentRef,
        paidAt: new Date(),
      });
    } else if (decision.next === 'failed' || decision.next === 'canceled') {
      await this.transition(orderId, [from], 'failed');
    } else if (decision.next === 'refunded') {
      await this.transition(orderId, [from], 'refunded', { refundedAt: new Date() });
    } else if (decision.next === 'partially_refunded') {
      // Legacy persistence has no partial-refund state or cumulative refund ledger.
      // Some money remains paid; do not claim a full refund or introduce a new persisted enum.
      await this.transition(orderId, [from], 'paid', { paymentId: paymentRef, paidAt: new Date() });
    }
    // created / authorized / unknown：仍在途，保持当前状态等待对账
  }

  /**
   * Legacy refund flow. Note: the legacy order model has no cumulative refunded amount, so
   * several partial refunds that add up to the total leave the order `paid`, and partial
   * detection compares each request with the original amount only. Use the RefundAdapter
   * protocol (`refunds/*`) when cumulative refund tracking matters.
   */
  async refundOrder(
    orderId: string,
    idempotencyKey: string,
    options: { money?: CreatePaymentInput['money']; reason?: string } = {},
  ): Promise<{ refundRef: string; state: SettlementState }> {
    const order = await this.getOrder(orderId);
    if (!order.paymentId) throw new Error(`订单 "${orderId}" 缺少 paymentId`);
    const partial = options.money === undefined ? false : isPartialRefund(options.money, order);
    await this.transition(orderId, ['paid'], 'refunding');
    let result: { refundRef: string; state: SettlementState };
    try {
      result = await this.providers.get(order.providerId).refund({
        providerRef: order.paymentId,
        money: options.money,
        reason: options.reason,
        idempotencyKey,
      });
    } catch (error) {
      // A definite provider rejection moved no money; unknown failures stay refunding.
      if (isDefinitePaymentRejection(error)) await this.transition(orderId, ['refunding'], 'paid');
      throw error;
    }
    if (result.state === 'partially_refunded' || (result.state === 'refunded' && partial)) {
      await this.transition(orderId, ['refunding'], 'paid');
      // A completed individual refund is not aggregate proof that the original payment is fully refunded.
      return { ...result, state: 'partially_refunded' };
    } else if (result.state === 'refunded') {
      await this.transition(orderId, ['refunding'], 'refunded', { refundedAt: new Date() });
    } else if (result.state === 'failed') {
      await this.transition(orderId, ['refunding'], 'paid');
    }
    // Pending or thrown outcomes stay refunding until reconciliation; they are not retried here.
    return result;
  }

  /**
   * 重试失败订单。
   * idempotencyKey 必须与上一次不同：沿用旧键会让渠道原样返回那笔已失败的支付，
   * 看起来"重试了"其实什么都没发生。
   */
  async retryOrder(
    orderId: string,
    idempotencyKey: string,
    payment: Pick<CreatePaymentInput, 'description' | 'returnUrl' | 'cancelUrl'> = {},
  ): Promise<Order> {
    const order = await this.getOrder(orderId);
    await this.transition(orderId, ['failed'], 'created');
    return this.initiatePayment(order, {
      reference: order.id,
      money: { amount: order.amount, currency: order.currency },
      metadata: order.metadata as Record<string, string> | undefined,
      description: payment.description,
      returnUrl: payment.returnUrl,
      cancelUrl: payment.cancelUrl,
      idempotencyKey,
    });
  }

  async cancelOrder(orderId: string): Promise<Order> {
    await this.transition(orderId, ['created', 'paying', 'failed'], 'cancelled');
    return this.getOrder(orderId);
  }

  async getOrder(orderId: string): Promise<Order> {
    const order = await this.orders.findUnique({ where: { id: orderId } });
    if (!order) throw new OrderNotFoundError(orderId);
    return order;
  }

  listOrders(): Promise<Order[]> {
    return this.orders.findMany();
  }

  private async transition(
    id: string,
    from: OrderStatus[],
    to: OrderStatus,
    data: Record<string, unknown> = {},
  ): Promise<void> {
    const changed = await this.orders.compareAndSet(
      id,
      { status: { in: from } },
      {
        ...data,
        status: to,
        updatedAt: new Date(),
      },
    );
    if (!changed) throw new Error(`订单 "${id}" 不存在或状态已变化，无法转换为 ${to}`);
  }
}

/** Compare decimal strings exactly without imposing Stripe's minor-unit rules on every provider. */
function isPartialRefund(
  money: CreatePaymentInput['money'],
  order: Pick<Order, 'amount' | 'currency'>,
): boolean {
  if (!money || money.currency !== order.currency || !/^[A-Z]{3}$/.test(money.currency)) {
    throw new Error('Refund currency must match the order currency');
  }
  const parts = (value: unknown): [string, string] => {
    if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value) || !/[1-9]/.test(value)) {
      throw new Error('Refund and order amounts must be positive decimal strings');
    }
    const [whole, fraction = ''] = value.split('.');
    return [whole.replace(/^0+(?=\d)/, ''), fraction.replace(/0+$/, '')];
  };
  const [requested, requestedFraction] = parts(money.amount),
    [total, totalFraction] = parts(order.amount);
  const decimals = Math.max(requestedFraction.length, totalFraction.length);
  const left = `${requested}.${requestedFraction.padEnd(decimals, '0')}`;
  const right = `${total}.${totalFraction.padEnd(decimals, '0')}`;
  if (requested.length > total.length || (requested.length === total.length && left > right)) {
    throw new Error('Refund amount must not exceed the original order amount');
  }
  return requested.length < total.length || left < right;
}
