// 接口和类型
export type {
  PaymentProvider,
  CreatePaymentParams,
  PaymentIntent,
  PaymentStatus,
  PaymentResult,
  RefundResult,
  WebhookEvent,
  SubscriptionPlan,
  Subscription,
  SubscriptionProvider,
} from './payment.interface';

// 服务
export { PaymentService } from './payment.service';
export { OrderService, OrderNotFoundError } from './order.service';
export type { Order, OrderStatus, CreateOrderParams } from './order.service';
export { DatabaseOrderPersistence, ORDER_PERSISTENCE } from './order-persistence';
export type { OrderPersistence } from './order-persistence';

// 挽回
export { PaymentRecoveryService, friendlyErrorReason } from './recovery.service';
export {
  RECOVERY_MAIL_SENDER,
  RECOVERY_USER_LOOKUP,
  RECOVERY_URL_GENERATOR,
  RECOVERY_ATTEMPT_STORE,
} from './recovery.service';
export type {
  RecoveryMailSender,
  RecoveryEmailParams,
  RecoveryUserLookup,
  RecoveryUrlGenerator,
  RecoveryOptions,
  RecoveryAttemptStore,
} from './recovery.service';

// 事件
export { PaymentEvents } from './payment.events';
export type {
  PaymentEventType,
  OrderFailedEvent,
  PaymentRecoverySentEvent,
} from './payment.events';

// 模块
export { ZuckerPaymentModule, PAYMENT_PROVIDERS } from './payment.module';
export type { PaymentModuleOptions, PaymentModuleAsyncOptions } from './payment.module';

export {
  createStripeClient, verifyStripeWebhookEvent, stripeResourceId,
  observeStripeCheckoutSession, createStripeCheckoutSession, retrieveStripeCheckoutSession,
  observeStripePaymentIntent, retrieveStripePaymentIntent,
} from './providers/stripe';
export type { StripeCheckoutObservation, StripePaymentIntentObservation } from './providers/stripe';
export type { PaymentSettlementState } from './providers/payment-observation';
export { PayPalPaymentTransport, observePayPalOrder, decodePayPalWebhookEvent } from './providers/paypal';
export type {
  PayPalPaymentTransportOptions,
  PayPalCaptureRefundRequest,
  PayPalCaptureRefundResponse,
  PayPalOrderRepresentation,
  PayPalOrderObservation,
  PayPalCaptureObservation,
  PayPalWebhookObservation,
} from './providers/paypal';
