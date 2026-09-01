import { Injectable, Logger } from '@nestjs/common';
import { PaymentService } from './payment.service';
import type { CreatePaymentParams, PaymentResult, RefundResult } from './payment.interface';

export type OrderStatus = 'created' | 'paying' | 'paid' | 'failed' | 'refunding' | 'refunded' | 'cancelled';

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

/**
 * 订单管理服务 — 创建订单 -> 支付 -> 完成/退款。
 *
 * 提供内存订单存储（生产环境应替换为数据库持久化）。
 */
@Injectable()
export class OrderService {
  private readonly logger = new Logger(OrderService.name);
  private readonly orders = new Map<string, Order>();

  constructor(private readonly paymentService: PaymentService) {}

  /** 创建订单并发起支付 */
  async createOrder(params: CreateOrderParams): Promise<Order> {
    const { orderId, providerId, payment } = params;

    if (this.orders.has(orderId)) {
      throw new Error(`订单 "${orderId}" 已存在`);
    }

    const now = new Date();
    const order: Order = {
      id: orderId,
      providerId,
      amount: payment.amount,
      currency: payment.currency,
      status: 'created',
      metadata: payment.metadata,
      createdAt: now,
      updatedAt: now,
    };

    this.orders.set(orderId, order);
    this.logger.log(`订单 "${orderId}" 已创建`);

    // 发起支付
    try {
      const intent = await this.paymentService.createPaymentIntent(providerId, payment);
      order.paymentIntentId = intent.id;
      order.status = 'paying';
      order.updatedAt = new Date();
      this.logger.log(`订单 "${orderId}" 支付已发起, intentId=${intent.id}`);
    } catch (error) {
      order.status = 'failed';
      order.updatedAt = new Date();
      this.logger.error(`订单 "${orderId}" 支付发起失败`, error);
      throw error;
    }

    return { ...order };
  }

  /** 确认订单支付 */
  async confirmOrder(orderId: string): Promise<PaymentResult> {
    const order = this.getOrder(orderId);

    if (order.status !== 'paying') {
      throw new Error(`订单 "${orderId}" 状态为 "${order.status}"，无法确认支付`);
    }

    if (!order.paymentIntentId) {
      throw new Error(`订单 "${orderId}" 缺少 paymentIntentId`);
    }

    const result = await this.paymentService.confirmPayment(order.providerId, order.paymentIntentId);

    if (result.status === 'succeeded') {
      order.status = 'paid';
      order.paymentId = result.id;
      order.paidAt = result.paidAt ?? new Date();
    } else {
      order.status = 'failed';
    }
    order.updatedAt = new Date();

    this.logger.log(`订单 "${orderId}" 支付结果: ${result.status}`);
    return result;
  }

  /** 订单退款 */
  async refundOrder(orderId: string, amount?: number, reason?: string): Promise<RefundResult> {
    const order = this.getOrder(orderId);

    if (order.status !== 'paid' && order.status !== 'refunding') {
      throw new Error(`订单 "${orderId}" 状态为 "${order.status}"，无法退款`);
    }

    if (!order.paymentId) {
      throw new Error(`订单 "${orderId}" 缺少 paymentId`);
    }

    order.status = 'refunding';
    order.updatedAt = new Date();

    const result = await this.paymentService.refund(order.providerId, order.paymentId, amount, reason);

    if (result.status === 'succeeded') {
      order.status = 'refunded';
      order.refundedAt = new Date();
    } else if (result.status === 'failed') {
      order.status = 'paid'; // 退款失败，恢复状态
    }
    order.updatedAt = new Date();

    this.logger.log(`订单 "${orderId}" 退款结果: ${result.status}`);
    return result;
  }

  /** 取消订单 */
  cancelOrder(orderId: string): Order {
    const order = this.getOrder(orderId);

    const cancellableStates = ['created', 'paying', 'failed'];
    if (!cancellableStates.includes(order.status)) {
      throw new Error(`订单 "${orderId}" 状态为 "${order.status}"，无法取消`);
    }

    order.status = 'cancelled';
    order.updatedAt = new Date();
    this.logger.log(`订单 "${orderId}" 已取消`);
    return { ...order };
  }

  /** 查询订单 */
  getOrder(orderId: string): Order {
    const order = this.orders.get(orderId);
    if (!order) {
      throw new Error(`订单 "${orderId}" 不存在`);
    }
    return order;
  }

  /** 列出所有订单 */
  listOrders(): Order[] {
    return Array.from(this.orders.values()).map((o) => ({ ...o }));
  }
}
