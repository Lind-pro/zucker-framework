// 渠道契约（适配器、状态模型、金额、契约套件）
export type {
  Money,
  PaymentNextAction,
  PaymentSession,
  CreatePaymentInput,
  RefundInput,
  WebhookRequest,
  WebhookObservation,
  PaymentProviderAdapter,
} from './contract/payment-contract';
export { adapterSupportsCurrency } from './contract/payment-contract';

export type { SettlementState, SettlementDecision } from './contract/settlement';
export { SETTLEMENT_STATES, reconcile, isMoneyMoved, isTerminal } from './contract/settlement';

export { toMinorUnits, fromMinorUnits, currencyExponent } from './contract/money';

export { PaymentProviderRegistry } from './contract/registry';

// 渠道适配器
export { createPayPalAdapter, observePayPalState, PAYPAL_SUPPORTED_CURRENCIES } from './contract/adapters/paypal.adapter';
export type { PayPalAdapterOptions } from './contract/adapters/paypal.adapter';
export { createStripeAdapter, observeStripeState } from './contract/adapters/stripe.adapter';
export type { StripeAdapterOptions } from './contract/adapters/stripe.adapter';

// 契约套件与参考实现：接入新渠道时必须跑通
export { checkPaymentAdapterContract } from './contract/contract-suite';
export type { ContractCheck, AdapterProbe } from './contract/contract-suite';
export { createFakeAdapter } from './contract/fake-adapter';
export type { FakeAdapterOptions } from './contract/fake-adapter';

// 服务
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
export { PayPalPaymentTransport, observePayPalOrder, decodePayPalWebhookEvent, decodePayPalMoneyReturnedEvent } from './providers/paypal';
export type {
  PayPalPaymentTransportOptions,
  PayPalCaptureRefundRequest,
  PayPalCaptureRefundResponse,
  PayPalOrderRepresentation,
  PayPalOrderObservation,
  PayPalCaptureObservation,
  PayPalMoneyReturnedObservation,
  PayPalWebhookObservation,
} from './providers/paypal';
