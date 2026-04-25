/**
 * 支付网关接口 — 不绑定任何具体支付商。
 * 用户通过注入 Stripe/PayPal/微信支付适配器来使用。
 */
export interface PaymentProvider {
  id: string;
  name: string;
  /** 创建支付意图/订单 */
  createPaymentIntent(params: CreatePaymentParams): Promise<PaymentIntent>;
  /** 确认支付 */
  confirmPayment(intentId: string): Promise<PaymentResult>;
  /** 退款 */
  refund(paymentId: string, amount?: number, reason?: string): Promise<RefundResult>;
  /** 查询支付状态 */
  getPaymentStatus(intentId: string): Promise<PaymentStatus>;
  /** 处理 Webhook */
  handleWebhook(payload: unknown, signature: string): Promise<WebhookEvent>;
}

export interface CreatePaymentParams {
  amount: number; // 最小单位（分/cents）
  currency: string; // ISO 4217
  description?: string;
  metadata?: Record<string, string>;
  customerId?: string;
  returnUrl?: string;
  cancelUrl?: string;
}

export interface PaymentIntent {
  id: string;
  clientSecret?: string;
  status: PaymentStatus;
  amount: number;
  currency: string;
  redirectUrl?: string;
}

export type PaymentStatus = 'pending' | 'processing' | 'succeeded' | 'failed' | 'cancelled' | 'refunded';

export interface PaymentResult {
  id: string;
  status: PaymentStatus;
  amount: number;
  currency: string;
  paidAt?: Date;
}

export interface RefundResult {
  id: string;
  paymentId: string;
  amount: number;
  status: 'pending' | 'succeeded' | 'failed';
  reason?: string;
}

export interface WebhookEvent {
  type: string;
  data: Record<string, unknown>;
}

// 订阅相关
export interface SubscriptionPlan {
  id: string;
  name: string;
  amount: number;
  currency: string;
  interval: 'day' | 'week' | 'month' | 'year';
  intervalCount: number;
  trialDays?: number;
  features?: string[];
}

export interface Subscription {
  id: string;
  planId: string;
  customerId: string;
  status: 'active' | 'past_due' | 'cancelled' | 'trialing' | 'paused';
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
}

export interface SubscriptionProvider {
  createSubscription(customerId: string, planId: string): Promise<Subscription>;
  cancelSubscription(subscriptionId: string, immediately?: boolean): Promise<Subscription>;
  getSubscription(subscriptionId: string): Promise<Subscription>;
  listSubscriptions(customerId: string): Promise<Subscription[]>;
  changePlan(subscriptionId: string, newPlanId: string): Promise<Subscription>;
}
