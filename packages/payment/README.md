# Payment persistence and provider access

`PaymentService` routes external provider calls. `OrderPersistence<T>` owns asynchronous order storage, and `DatabaseOrderPersistence<T>` binds that contract to an existing `ModelOperations<T>` database model. It preserves native Decimal, Date and JSON values, accepts existing include/select/filter arguments and performs `compareAndSet(id, expected, data)` through one conditional `updateMany` statement. The database must enforce a unique order ID. A transaction-bound model stays on that transaction; the persistence class never starts a transaction or switches to another connection.

Applications with existing order schemas use this public persistence contract directly. They retain their status vocabulary, pricing, product line items, fulfillment and event projections. They do not need a second order table or to translate amounts into another storage format. Confirmed external payment status must be validated before invoking a paid transition.

## Configured Framework order workflow

`OrderService` now requires `OrderPersistence<Order>` as its second constructor argument. `ZuckerPaymentModule.forRoot` / `forRootAsync` require `orderPersistence`; there is no implicit Map store. Configure the module once. `getOrder`, `listOrders`, `cancelOrder` and recovery reads are asynchronous.

Provider operations execute outside database transactions. The service persists creation before calling a provider and uses conditional status updates to claim confirmation/refund work. Concurrent callers cannot both claim the same transition. Unknown create/confirm/refund outcomes remain `created` / `confirming` / `refunding` for reconciliation; errors do not authorize automatic repeated payment attempts. A confirmation response of `pending` or `processing` also stays `confirming`, while `refunded` stays terminal. A failed write of a returned provider ID is surfaced instead of returning a successful unsaved order.

The supplied store must persist the `Order` contract's fields. In-memory implementations may be explicitly supplied in isolated tests but do not prove durability or database concurrency. The generic workflow is not an application fulfillment engine and does not guarantee exactly-once external effects; applications retain provider idempotency, reconciliation and any required durable delivery/outbox.

## Recovery attempts

Recovery mail requires `RecoveryAttemptStore`, configured as `recoveryAttempts` or through `RECOVERY_ATTEMPT_STORE`. Its `claim` must atomically persist a unique attempt number under the configured limit before returning. `get` reads persisted attempts. There is no built-in counter, implicit memory fallback or database table assumption; callers supply storage matching their existing schema. A missing sender skips without reserving; a missing attempt store fails explicitly; database failures propagate.

Each reserved mail attempt receives `payment-recovery:<orderId>:<attemptNumber>` as its idempotency key. Failed or unknown sends keep their reservation. The sender must forward the key to its provider; this is an attempt limit, not a promise of exactly-once mail delivery. Recipient selection, cooldown windows, templates and business recovery policy remain in the consumer.

## Migration and verification

This is a breaking source change: configure an order store, await the formerly synchronous methods, provide recovery-attempt persistence when enabling recovery mail, and replace direct mutation of a returned order with persisted operations. `retryOrder` now delegates to the durable order service. `OrderNotFoundError` distinguishes absence from database failure.

Validation on 2026-09-11: all 7 payment unit-test files (38 tests) and the package no-emit typecheck passed, covering durable-order ports, in-flight outcomes, recovery attempts and mocked provider adapters. The consumer PostgreSQL contract and real provider paths are not established by this unit run. Consumers require a new immutable version and application/CI verification before release; existing published versions remain unchanged.

## Hosted provider observations

Stripe access exposes `createStripeCheckoutSession`, `retrieveStripeCheckoutSession` and `retrieveStripePaymentIntent`. Each delegates exactly once with the supplied SDK request parameters and returns both the untouched `raw` response and normalized evidence. The pure `observeStripeCheckoutSession` / `observeStripePaymentIntent` functions also handle verified webhook objects. Expandable payment-intent/subscription/charge IDs are normalized; payment-method type is returned only when the charge is already expanded. Expanding a charge remains an explicit caller request.

`PayPalPaymentTransport.createOrder`, `captureOrder` and `getOrder` preserve the installed SDK request shape and return `raw`, ID, approval URL, first capture ID and settlement evidence. `observePayPalOrder` works on stored responses without a request. `getOrder` never invokes capture; `APPROVED`, `CREATED` and other nonterminal states are `unknown`, `COMPLETED` is `paid`, and `VOIDED` is `unpaid`. Stripe likewise distinguishes paid evidence from expired/canceled objects and leaves pending evidence unknown.

`decodePayPalWebhookEvent` decodes standard capture event/resource fields after the caller has verified the signature. Recognized capture events require a nonempty resource ID, preventing an undefined identity from reaching a consumer's database filter. Unknown event types remain unhandled observations. Decoding does not verify signatures or apply product effects.

These APIs do not interpret product metadata, choose prices/currencies or success URLs, change retries/SDK versions, activate refunds, or write orders/subscriptions. Consumers decide whether an explicit capture result is a business failure and own all reconciliation/fulfillment. The existing optional refund API is unchanged; this migration covers active hosted-payment paths only.
