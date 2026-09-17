import { Injectable, Inject } from '@nestjs/common';
import { PaymentProviderRegistry } from './contract/registry';
import type { CreatePaymentInput, PaymentSession } from './contract/payment-contract';
import { reconcile, type SettlementState } from './contract/settlement';
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
    const session = await this.providers.get(order.providerId).createPayment(payment);
    await this.transition(order.id, ['created'], 'paying', { paymentIntentId: session.providerRef });
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
    const session = await this.providers
      .get(order.providerId)
      .capture(order.paymentIntentId, idempotencyKey);
    await this.applySettlement(orderId, 'confirming', session.state, session.providerRef);
    return session;
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
    } else if (decision.next === 'refunded' || decision.next === 'partially_refunded') {
      await this.transition(orderId, [from], 'refunded', { refundedAt: new Date() });
    }
    // created / authorized / unknown：仍在途，保持当前状态等待对账
  }

  async refundOrder(
    orderId: string,
    idempotencyKey: string,
    options: { money?: CreatePaymentInput['money']; reason?: string } = {},
  ): Promise<{ refundRef: string; state: SettlementState }> {
    const order = await this.getOrder(orderId);
    if (!order.paymentId) throw new Error(`订单 "${orderId}" 缺少 paymentId`);
    await this.transition(orderId, ['paid'], 'refunding');
    const result = await this.providers.get(order.providerId).refund({
      providerRef: order.paymentId,
      money: options.money,
      reason: options.reason,
      idempotencyKey,
    });
    if (result.state === 'refunded') {
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
  async retryOrder(orderId: string, idempotencyKey: string): Promise<Order> {
    const order = await this.getOrder(orderId);
    await this.transition(orderId, ['failed'], 'created');
    return this.initiatePayment(order, {
      reference: order.id,
      money: { amount: order.amount, currency: order.currency },
      metadata: order.metadata as Record<string, string> | undefined,
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
