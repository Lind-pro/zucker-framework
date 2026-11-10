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

export { toMinorUnits, fromMinorUnits, currencyExponent, toStripeMinorUnits, fromStripeMinorUnits } from './contract/money';

export { PaymentRejectedError, isDefinitePaymentRejection } from './contract/rejection';

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
export {
  OrderService, OrderNotFoundError, PENDING_REFUND_KEY, PARTIAL_REFUND_COUNT_KEY, partialRefundCount, pendingRefund,
} from './order.service';
export type { Order, OrderStatus, CreateOrderParams, PendingRefund } from './order.service';
export { DatabaseOrderPersistence, ORDER_PERSISTENCE } from './order-persistence';
export type { OrderPersistence } from './order-persistence';
export { HostedCheckoutService } from './hosted-checkout/service';
export { SubscriptionCycleService } from './subscription-lifecycle/service';
export type { SubscriptionEntitlementBinding, SubscriptionCycleReceipt, SubscriptionCycleTransaction,
  SubscriptionCyclePersistence, SubscriptionCycleInput } from './subscription-lifecycle/types';
export { HostedCheckoutError } from './hosted-checkout/types';
export type { HostedCheckoutMode, HostedCheckoutState, HostedCheckoutPaymentKind, HostedCheckoutJsonValue, HostedCheckoutOffer, HostedCheckoutOrder,
  HostedCheckoutObservation, HostedCheckoutEvent, HostedCheckoutAdapter, HostedCheckoutTransaction,
  HostedCheckoutPersistence, HostedCheckoutSelection, HostedCheckoutOptions } from './hosted-checkout/types';
export { createStripeHostedCheckoutAdapter } from './hosted-checkout/stripe';
export type { StripeHostedCheckoutOptions } from './hosted-checkout/stripe';
export { createPayPalHostedCheckoutAdapter } from './hosted-checkout/paypal';
export type { PayPalHostedCheckoutOptions } from './hosted-checkout/paypal';
export { createCreemHostedCheckoutAdapter } from './hosted-checkout/creem';
export type { CreemHostedCheckoutOptions } from './hosted-checkout/creem';

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
export { createCreemAdapter, observeCreemCheckout, observeCreemTransaction, observeCreemSubscription,
  observeCreemWebhook, verifyCreemWebhookEvent, CreemProtocolError } from './providers/creem';
export type { CreemCheckoutAdapter } from './providers/creem';
export type { CreemAdapterOptions, CreemCheckoutRequest, CreemCheckoutObservation, CreemTransactionObservation,
  CreemSubscriptionObservation, CreemRefundObservation, CreemWebhookObservation } from './providers/creem-types';
export { subscriptionPeriodKey } from './contract/subscription-observation';
export type { SubscriptionPeriod, SubscriptionStatus, SubscriptionObservation } from './contract/subscription-observation';
export { PayPalPaymentTransport, PayPalPaymentProtocolError, observePayPalOrder, decodePayPalWebhookEvent, decodePayPalMoneyReturnedEvent } from './providers/paypal';
export type {
  PayPalPaymentTransportOptions,
  PayPalSubscriptionCreateInput,
  PayPalSubscriptionTransaction,
  PayPalSubscriptionTransactionPage,
  PayPalCaptureRefundRequest,
  PayPalCaptureRefundResponse,
  PayPalSaleRefundRequest,
  PayPalOrderRepresentation,
  PayPalOrderObservation,
  PayPalCaptureObservation,
  PayPalMoneyReturnedObservation,
  PayPalWebhookObservation,
} from './providers/paypal';

export { RefundProtocolError } from './refunds/types';
export type { RefundAdapter, RefundCommand, RefundPaymentReference, RefundPaymentSource, RefundPaymentObservation,
  RefundObservation, RefundWebhookEvent, RefundState } from './refunds/types';
export { createStripeRefundAdapter } from './refunds/stripe';
export type { StripeRefundOptions } from './refunds/stripe';
export { createPayPalRefundAdapter } from './refunds/paypal';
export type { PayPalRefundOptions } from './refunds/paypal';
export { createCreemRefundAdapter } from './refunds/creem';
export type { CreemRefundOptions } from './refunds/creem';

export { SubscriptionProtocolError } from './subscriptions/types';
export type { SubscriptionAdapter, SubscriptionDetails, SubscriptionPaidPeriod, SubscriptionPaidPeriodPage,
  SubscriptionPaidReceipt, SubscriptionPaidReceiptPage, SubscriptionEvidenceIssue, SubscriptionInvoice, SubscriptionCancelMode } from './subscriptions/types';
export { createStripeSubscriptionAdapter } from './subscriptions/stripe';
export type { StripeSubscriptionOptions } from './subscriptions/stripe';
export { createCreemSubscriptionAdapter } from './subscriptions/creem';
export type { CreemSubscriptionOptions } from './subscriptions/creem';
export { createPayPalSubscriptionAdapter, observePayPalSubscription } from './subscriptions/paypal';
export type { PayPalSubscriptionOptions, PayPalSubscriptionPeriodReceipt } from './subscriptions/paypal';

// 套餐目录与用户订阅指派（套餐内容、价格与功能目录由消费者提供）
export {
  PlanCatalogService,
  PlanCatalogError,
  validatePlanWrite,
  validatePlanPrices,
  normalizePlanAmount,
  planOfferId,
  parsePlanOfferId,
  planCheckoutMode,
  readPlanPriceSnapshot,
  validateCredits,
  validateExpiryDays,
  validateLocalizedText,
  validateProviderRefs,
  DEFAULT_PROVIDER_REF_FORMATS,
  MAX_PLAN_PRICES,
  MAX_ONE_TIME_TERM_DAYS,
  MAX_LOCALIZED_ENTRIES,
} from './plans/plan-catalog';
export {
  CreditPackCatalogService,
  CreditPackCatalogError,
  validateCreditPackWrite,
  validateCreditPackPrices,
  packOfferId,
  parsePackOfferId,
  localizedText,
  MAX_CREDIT_PACK_PRICES,
} from './plans/credit-pack-catalog';
export type {
  CreditPackRecord,
  CreditPackWrite,
  CreditPackPrice,
  CreditPackStore,
  CreditPackCatalogOptions,
  CreditPackSnapshot,
  ResolvedCreditPackOffer,
} from './plans/credit-pack-catalog';
export type {
  SubscriptionPlanRecord,
  SubscriptionPlanWrite,
  PlanPrice,
  PlanPriceInterval,
  PlanCreditExpiry,
  LocalizedText,
  PlanPriceSnapshot,
  ResolvedPlanOffer,
  PlanCatalogErrorReason,
  PlanCatalogStore,
  PlanUpdateOptions,
  PlanCatalogServiceOptions,
} from './plans/plan-catalog';
export { SubscriptionAssignmentService, SubscriptionAssignmentError, addBillingCycle } from './plans/subscription-assignment';
export type {
  UserSubscriptionStatus,
  UserSubscriptionCycle,
  UserSubscriptionSource,
  UserSubscriptionRecord,
  UserSubscriptionWrite,
  AssignablePlan,
  SubscriptionPaymentEvidence,
  PendingPaymentBlock,
  UserSubscriptionStore,
  SubscriptionAssignmentErrorReason,
  SubscriptionAssignmentInput,
  SubscriptionPaymentInput,
  SubscriptionPurchaseInput,
  PlanPurchaseRefusal,
  SubscriptionPaymentOutcome,
  SubscriptionPaymentResult,
  SubscriptionChange,
  SubscriptionAssignmentOptions,
} from './plans/subscription-assignment';
