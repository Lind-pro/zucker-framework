import { Injectable, Inject } from '@nestjs/common';
import { PaymentService } from './payment.service';
import type { CreatePaymentParams, PaymentResult, RefundResult } from './payment.interface';
import { ORDER_PERSISTENCE, type OrderPersistence } from './order-persistence';

export type OrderStatus =
  'created' | 'paying' | 'confirming' | 'paid' | 'failed' | 'refunding' | 'refunded' | 'cancelled';
export interface Order {
  id: string;
  providerId: string;
  paymentIntentId?: string;
  paymentId?: string;
  amount: number;
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
  payment: CreatePaymentParams;
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
    private readonly paymentService: PaymentService,
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
        amount: params.payment.amount,
        currency: params.payment.currency,
        metadata: params.payment.metadata,
        status: 'created',
        createdAt: now,
        updatedAt: now,
      },
    });
    return this.initiatePayment(order, params.payment);
  }

  private async initiatePayment(order: Order, payment: CreatePaymentParams): Promise<Order> {
    // Unknown provider outcomes remain created for reconciliation; never automatically re-charge.
    const intent = await this.paymentService.createPaymentIntent(order.providerId, payment);
    await this.transition(order.id, ['created'], 'paying', { paymentIntentId: intent.id });
    return this.getOrder(order.id);
  }

  async confirmOrder(orderId: string): Promise<PaymentResult> {
    const order = await this.getOrder(orderId);
    if (!order.paymentIntentId) throw new Error(`订单 "${orderId}" 缺少 paymentIntentId`);
    await this.transition(orderId, ['paying'], 'confirming');
    // A thrown/unknown outcome stays confirming; a second caller cannot issue another capture.
    const result = await this.paymentService.confirmPayment(
      order.providerId,
      order.paymentIntentId,
    );
    if (result.status === 'succeeded') {
      await this.transition(orderId, ['confirming'], 'paid', {
        paymentId: result.id,
        paidAt: result.paidAt ?? new Date(),
      });
    } else if (result.status === 'failed' || result.status === 'cancelled') {
      await this.transition(orderId, ['confirming'], 'failed');
    } else if (result.status === 'refunded') {
      await this.transition(orderId, ['confirming'], 'refunded');
    }
    // pending/processing are in-flight outcomes, not permission to capture again.
    // Keep the claimed confirming state until a read-only reconciliation resolves it.
    return result;
  }

  async refundOrder(orderId: string, amount?: number, reason?: string): Promise<RefundResult> {
    const order = await this.getOrder(orderId);
    if (!order.paymentId) throw new Error(`订单 "${orderId}" 缺少 paymentId`);
    await this.transition(orderId, ['paid'], 'refunding');
    const result = await this.paymentService.refund(
      order.providerId,
      order.paymentId,
      amount,
      reason,
    );
    if (result.status === 'succeeded') {
      await this.transition(orderId, ['refunding'], 'refunded', { refundedAt: new Date() });
    } else if (result.status === 'failed') {
      await this.transition(orderId, ['refunding'], 'paid');
    }
    // Pending or thrown outcomes stay refunding until reconciliation; they are not retried here.
    return result;
  }

  async retryOrder(orderId: string): Promise<Order> {
    const order = await this.getOrder(orderId);
    await this.transition(orderId, ['failed'], 'created');
    return this.initiatePayment(order, {
      amount: order.amount,
      currency: order.currency,
      metadata: order.metadata,
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
