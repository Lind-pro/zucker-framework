/**
 * 支付系统事件常量及接口
 */

export const PaymentEvents = {
  ORDER_CREATED: 'payment.order.created',
  ORDER_PAID: 'payment.order.paid',
  ORDER_FAILED: 'payment.order.failed',
  ORDER_CANCELED: 'payment.order.canceled',
  ORDER_REFUNDED: 'payment.order.refunded',
  PAYMENT_RECOVERY_SENT: 'payment.recovery.sent',
} as const;

export type PaymentEventType = (typeof PaymentEvents)[keyof typeof PaymentEvents];

export interface OrderFailedEvent {
  orderId: string;
  orderNumber?: string;
  userId?: string;
  amount: number;
  currency: string;
  providerId: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface PaymentRecoverySentEvent {
  orderId: string;
  userId?: string;
  email: string;
  retryUrl: string;
  attemptNumber: number;
}
