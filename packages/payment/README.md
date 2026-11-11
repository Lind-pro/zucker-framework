# Payment persistence and provider access

`PaymentService` routes external provider calls. `OrderPersistence<T>` owns asynchronous order storage, and `DatabaseOrderPersistence<T>` binds that contract to an existing `ModelOperations<T>` database model. It preserves native Decimal, Date and JSON values, accepts existing include/select/filter arguments and performs `compareAndSet(id, expected, data)` through one conditional `updateMany` statement. The database must enforce a unique order ID. A transaction-bound model stays on that transaction; the persistence class never starts a transaction or switches to another connection.

Applications with existing order schemas use this public persistence contract directly. They retain their status vocabulary, pricing, product line items, fulfillment and event projections. They do not need a second order table or to translate amounts into another storage format. Confirmed external payment status must be validated before invoking a paid transition.

## Configured Framework order workflow

`OrderService` now requires `OrderPersistence<Order>` as its second constructor argument. `ZuckerPaymentModule.forRoot` / `forRootAsync` require `orderPersistence`; there is no implicit Map store. Configure the module once. `getOrder`, `listOrders`, `cancelOrder` and recovery reads are asynchronous.

Provider operations execute outside database transactions. The service persists creation before calling a provider and uses conditional status updates to claim confirmation/refund work. Concurrent callers cannot both claim the same transition. Unknown create/confirm/refund outcomes remain `created` / `confirming` / `refunding` for reconciliation; errors do not authorize automatic repeated payment attempts. A confirmation response of `pending` or `processing` also stays `confirming`, while `refunded` stays terminal. A failed write of a returned provider ID is surfaced instead of returning a successful unsaved order.

A definite provider rejection (4xx) of a capture or refund is not taken as proof that no money moved: PayPal, for example, answers 422 `ORDER_ALREADY_CAPTURED` for an order captured through another path. `confirmOrder` and `refundOrder` first read the payment with `adapter.retrieve`. A capture reopens `paying` only when the provider reports `created` or `authorized`; `captured` records `paid`; a failing read or `unknown` leaves `confirming`. A refund records `refunded` when observed, returns to `paid` on `captured` (nothing refunded, or an adapter that cannot observe refunds) or on `partially_refunded` explained by an earlier recorded partial refund, and otherwise stays `refunding`. The original error is still thrown; re-read the order for its state.

Refund bookkeeping lives in `Order.metadata` under the reserved keys `zucker.pendingRefund` (JSON of the attempted command while the order is `refunding`) and `zucker.partialRefundCount` (completed partial refunds); `retryOrder` does not send them to the provider. `reconcileOrder` accepts a `partially_refunded` observation as the outcome of a pending refund only when no partial refund was recorded before: otherwise the observation may describe the earlier refund, so the order stays `refunding` and an operator must call `resolveRefund` after checking the provider. Every exit from `refunding` clears the pending marker.

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

## Creem catalog Checkout and subscription observations

`createCreemAdapter({ apiKey, environment: 'test' | 'production', webhookSecret, fetch?, timeoutMs? })`
adds a server-side, dependency-free Creem protocol adapter. It uses the configured environment's
official API origin, rejects redirects, and makes one HTTP request per operation with a bounded
timeout. It does not read application environment variables, choose products/prices, retry mutations,
write subscriptions, or grant access. A supplied `fetch` allows isolated protocol tests.

Supported operations:

| API | Scope and evidence |
| --- | --- |
| `createCheckout({ productId, requestId, ... })` | One-time or recurring **catalog product** Checkout; optional units, customer, discount/affiliate code, metadata, success URL, and documented one-time custom cents price. Persist `requestId` before calling and reuse it only for the same intended request. |
| `retrieveCheckout(id)` | Read-only GET by Checkout ID. Returns separate Checkout, order, transaction and subscription references. `completed` alone does not establish capture; free-trial/lifecycle completion remains unknown without paid order evidence. |
| `retrieveTransaction(id)` | Read-only transaction evidence, actual paid/refunded money when supplied, and the transaction's own billing period. Chargebacks remain unknown rather than being fabricated as ordinary refunds. |
| `retrieveSubscription(id)` | Lifecycle status and current period are separate from payment evidence. An `active` status or `last_transaction_id` does not prove that the current period was paid. |
| `cancelSubscription(id, { mode, onExecute? })` | Explicit immediate or scheduled cancellation; scheduled pause is also supported. No automatic retry, default merchant cancellation mode, local entitlement change or cash refund. |
| `refundTransaction(transactionId)` | Creem's documented **full remaining** refund endpoint. No partial amount input and no documented provider idempotency header; caller must durably claim the action before calling. A pending/failed/unknown result is not refunded. The response may contain only status, so no refund ID is invented. |
| `parseWebhook(request)` | HMAC-SHA256 verification over the original bytes, timing-safe comparison, required event identity/time, and environment check before observation. No network requests or business side effects. |

`verifyCreemWebhookEvent` verifies independently; `observeCreemWebhook`, `observeCreemCheckout`,
`observeCreemTransaction` and `observeCreemSubscription` decode already trusted/verified data without
I/O. Keep raw responses private. Persist event IDs and source account identity; signatures alone do
not prevent replay, and event time is evidence rather than a built-in freshness/ordering policy.
Unknown event types are retained without assigning a successful payment state. A `refund.created`
event uses its transaction's full/partial refund state instead of assuming every refund is full.

Creem documents integer **cents** for these amount fields. The adapter validates safe integer cents
and preserves currency; it does not apply Stripe's zero-decimal-currency conversion rules to Creem.
Checkout `paidMoney` and `dueMoney` are distinct and remain absent when the API omits them. Product
catalog price is not substituted for either field. Consumers must validate their expected money,
tax/discount treatment and resource ownership before applying a paid transition.

### Existing order integration boundary

This catalog API is intentionally not cast to `PaymentProviderAdapter`: that interface's
`createPayment({ money })` has no product reference, requires money in every `PaymentSession`, and
its refund result requires an ID that Creem's refund endpoint does not return. Consequently Creem
is **not** yet a drop-in provider for `PaymentProviderRegistry` / `OrderService` / `ZuckerPaymentModule`.
Forcing those contracts would invent a pending amount, an arbitrary catalog mapping or a refund ID.
The existing amount-based Stripe/PayPal contracts are unchanged.

An application with an existing order model can use `DatabaseOrderPersistence` directly:

1. In its existing transaction, save the local order, allowed Creem product, accepted commercial
   terms and stable Checkout request ID. Uniquely claim a submission before leaving the transaction.
2. Outside that transaction, call `createCheckout` and persist the returned Checkout ID and URL.
   A lost response or failed write leaves a reconciliation case; it does not authorize a new request ID.
3. Verify a webhook or query the stored Checkout ID. Check the returned order/customer/transaction,
   expected money and source account against the local record. Use the existing transactional
   persistence port and an expected-state update when applying the observation.
4. Apply product fulfillment under its own stable operation key in that same local transaction
   (or persist an outbox). Do not grant twice for both `checkout.completed` and `subscription.paid`.
5. For refund requests, persist a unique local claim and the transaction ID before the one provider
   call. Keep pending/unknown requests for read-only transaction/event reconciliation; never generate
   a second refund simply because a transport exception or timeout occurred.

The new neutral `SubscriptionObservation` exposes lifecycle, period and payment evidence separately.
`subscriptionPeriodKey({ provider, accountScope, subscriptionId, period })` creates a deterministic,
namespace-bound cycle identity using normalized timestamps. The consumer enforces uniqueness and
atomic grant/reversal through its existing store/credit mechanism. Event ID, product/entitlement
version and mutable status are not part of that base-cycle key. Missing period facts must be
reconciled before using a cycle key; the helper does not calculate a period from a plan's interval.
A previous expanded transaction can have a different period from the current subscription.

### Verification and primary protocol references

The new tests exercise synthetic HTTP responses and signed local payloads: product/request forwarding,
read-only queries, unknown/partial outcomes, trial vs paid evidence, event replay identity, environment
mismatch, invalid signatures, encoded IDs, malformed responses and absence of automatic mutation
retries. They do **not** establish real Creem availability, a PostgreSQL grant transaction, a hosted
checkout browser flow, or a published consumer integration. No real charge/refund is part of this run.

Protocol checked 2026-10-24 against Creem's official [Checkout endpoint](https://docs.creem.io/api-reference/endpoint/create-checkout),
[Checkout retrieval](https://docs.creem.io/api-reference/endpoint/get-checkout),
[refund endpoint](https://docs.creem.io/api-reference/endpoint/refund-payment),
[subscription retrieval](https://docs.creem.io/api-reference/endpoint/get-subscription),
[cancellation endpoint](https://docs.creem.io/api-reference/endpoint/cancel-subscription),
[webhook guide](https://docs.creem.io/code/webhooks) and official repository's
[OpenAPI schema](https://github.com/armitage-labs/creem/blob/main/packages/sdk/openapi.json).
No ShipAny application implementation was copied. These are additive source APIs; a consumer's
fixed-version integration, durable cycle fulfillment and provider sandbox/live validation remain
separate completion evidence. The initial-order workflow below adds catalog-provider consumption.

## Durable hosted checkout and initial fulfillment

`HostedCheckoutService` is an additive workflow for a single catalog item, quantity one, with an
exact positive initial amount. It accepts `HostedCheckoutPersistence`, the existing
`OrderPersistence<HostedCheckoutOrder>` port, configured providers, a server-only `resolveOffer`
callback and server-controlled `returnUrls(orderId)`. No product catalog, prices, user ownership
policy, database schema, environment configuration or entitlement rules live in the library.
`OrderService` and `PaymentProviderRegistry` remain compatible and are not silently replaced.

```ts
import {
  HostedCheckoutService,
  type HostedCheckoutOptions,
} from '@zucker-framework/payment';

// Consumer composition root supplies durable adapters and a server-side catalog.
declare const options: HostedCheckoutOptions;
const checkout = new HostedCheckoutService(options);
const order = await checkout.create({
  orderId: 'persisted-server-checkout-id',
  ownerId: 'authenticated-session-user-id',
  offerId: 'server-catalog-offer-id',
  providerId: 'stripe',
});
// Expose only the public order status/checkout URL needed by the browser.
await checkout.confirm({ orderId: order.id, ownerId: order.ownerId });
// PayPal one-time Orders only: invoke after approval, never from a status GET/webhook.
// await checkout.capture({ orderId: order.id, ownerId: order.ownerId });
```

`resolveOffer` freezes `{ version, catalogReference, mode, money, description, fulfillmentData? }` on the first insert.
Duplicate requests reuse that snapshot even if the current catalog price changes. The owner,
selection and provider account scope must match. Always derive `ownerId` from the authenticated
session; reuse a persisted server-side `orderId` for retries. Creating a new order ID represents
a new purchase, not a retry. The configured `accountScope` identifies one provider account and
environment for the lifetime of its orders; do not point an old scope at new credentials.

`fulfillmentData` is an optional opaque plain JSON record for the consumer's accepted entitlement
policy, such as its own grant quantity and expiration terms. The library does not interpret its
keys. `fulfill(order)` must use the persisted snapshot rather than re-resolving today's catalog.
Values may be strings, booleans, finite numbers, null, dense arrays and plain records (maximum
nesting depth 64). Undefined members, functions, bigint/symbols, accessors, class instances/dates,
cycles and lossy array properties are rejected before any order insert. The service clones the
policy and removes it from provider validation/create inputs; built-in adapters also never map
it into external metadata. Changing a catalog configuration cannot change an existing order's
fulfillment terms.

`create` also accepts optional `providerMetadata`, separately from private `fulfillmentData`.
This must be an allowlisted mapping created by the consumer server, such as the result of
`@zucker-framework/fe-site`'s `referralMetadata` revalidation. The first order freezes the metadata;
duplicate creation preserves the original attribution. The service accepts at most 50 string
fields, ASCII identifier keys up to 40 characters and values up to 500 characters without control
characters. Order/offer/owner/reference/request correlation keys and prototype keys are reserved.
Arbitrary browser metadata is never a supported input. Stripe and Creem declare
`supportsMetadata: true` and forward validated public metadata while retaining their own correlation
fields; PayPal declares false and rejects nonempty metadata before dispatch, because Orders v2
has no arbitrary metadata record. No JSON is hidden in its custom ID.

Transport support and affiliate attribution are different claims. Affonso documents
[`metadata.affonso_referral` for Creem Checkout](https://affonso.io/help/integrations/creem/creem-checkout-api)
and [Stripe Checkout](https://affonso.io/help/tracking-settings/debug-stripe-tracking), with the
provider account connected in Affonso. PromoteKit documents
[`metadata.promotekit_referral` for Stripe](https://www.promotekit.com/docs/affiliate-links/stripe-api).
These sources do not establish native PromoteKit/Creem or either vendor's native PayPal attribution.
Consumers choose supported combinations; a metadata string is never evidence of payment or entitlement.

Provider setup uses public adapters:

| Adapter | Catalog binding and capability |
| --- | --- |
| `createStripeHostedCheckoutAdapter({ client, accountScope, livemode, webhookSecret? })` | Stripe Price ID, payment or initial subscription Checkout. With `client.prices` it implements `quote`: the Price's amount/currency/type is read before an order exists and an archived or different price refuses the checkout. Retrieval expands line items and checks exact quantity/catalog/money. `no_payment_required` does not prove paid money. One-time payment intent and subscription invoice references remain distinct. No explicit capture. |
| `createPayPalHostedCheckoutAdapter({ transport, accountScope, webhookId?, brandName? })` | Server catalog SKU and exact totals for Orders v2; full `PayPalPaymentTransport` also enables Subscriptions v1 with a server-owned existing Plan ID. Fixed-price, quantity-one, no-trial/setup/tax-override plans are validated before creation, and `quote` reads the plan price before an order exists. Subscriptions use the local order as `custom_id`, the persisted create key as `PayPal-Request-Id`, and approval URLs. Read-only confirmation enumerates the earliest actual settled transaction; a refunded first payment cannot be replaced with a later renewal. Explicit capture applies only to one-time approved Orders. Multiple/partial captures are outside this workflow. |
| `createCreemHostedCheckoutAdapter({ adapter, accountScope })` | Wraps `createCreemAdapter`; forwards product ID, stable local order ID as `request_id`, quantity one and success URL. Uses paid order/transaction evidence, never product price. Supports one-time or initial subscription purchase. Creem exposes no cancel URL in this API. No capture or refund method is fabricated. |

Create/capture provider calls occur outside database transactions. Before each call, an atomic CAS
persists a `submitting` claim and stable operation key. A transport error, lost response or failed
provider-ID write leaves that claim intact. `create`/`capture` do **not** automatically replay it,
even after restart. Status reconciliation uses the stored checkout ID. When creation outcome is
unknown, an authenticated return or verified webhook may supply a checkout-ID hint; the service
re-reads the provider and requires the original order reference, catalog and quantity before
binding it. Missing correlation evidence is an error, not permission to grant or create again.

Before releasing a new payable URL, known outstanding money must match the frozen offer. A mismatch
leaves the claimed creation unresolved and returns no URL; it never silently charges a changed catalog
price. A settled checkout may report zero outstanding money, so actual paid money is verified separately.
Earlier still, an adapter's optional `quote(offer)` reads the provider's own price for the catalog
reference before any order is stored: a different amount, currency or mode refuses the checkout with
`conflict`, so an administrator-edited catalog amount that no longer matches the provider price fails
cleanly instead of leaving an unresolved creation (or, for providers that report no outstanding
amount, charging the buyer and then failing verification). `null` means the provider cannot tell.
The Stripe adapter preserves the application's return parameters and appends
`session_id={CHECKOUT_SESSION_ID}` using Stripe's documented
[hosted Checkout return mechanism](https://docs.stripe.com/payments/existing-customers?platform=web&ui=stripe-hosted).
The returned ID is only a reconciliation hint and never proof of payment.

`webhook(providerId, { rawBody, headers })` verifies the original request before local lookup, then
re-reads the provider resource. Event payload state does not grant access. Unsupported events
return `null`; a recognized event without a local order raises `not_found` so consumers can retry
or quarantine it. Preserve the raw body in HTTP integration. Configure signature secrets/IDs
before enabling the endpoint. Renewals, cancellations, disputes and refunds are not initial-order
fulfillment events and require the separate subscription/refund workflows.

### Transaction and database requirements

The consumer implements `HostedCheckoutPersistence.transaction(work)` using its real database
transaction. Pass `work({ orders, fulfill })` with a **transaction-bound** order store and a
`fulfill(order)` callback that writes entitlements/ledger entries or a durable outbox on that same
transaction. `DatabaseOrderPersistence` can bind the existing model operations. There is no
implicit in-memory store or second database connection. A callback failure must roll back both
the paid CAS and every fulfillment write. Never send email, call payment/AI providers or perform
other external effects from `fulfill`; deliver an outbox with its own idempotent consumer instead.

An optional `prepareFulfillment(order, observation)` runs only after full paid evidence is verified,
before opening that transaction. Use it for read-only provider checks and durable preparation, such
as resolving an invoice's funding source and recording early refunds before granting credits. Inputs
are isolated snapshots; failure leaves fulfillment retryable. It may run concurrently or repeatedly,
must not dispatch a charge/refund, and does not replace a final restriction check under the account
lock in `fulfill`. Stripe subscription checkout uses the invoice identity shared by cycle receipts,
even if a payment intent is also present; missing invoice evidence does not fall back to a new identity.

Persist all `HostedCheckoutOrder` fields, including native dates, immutable offer JSON, operation
claims and `revision`. Enforce a unique `id`, a unique non-null
`(providerId, accountScope, checkoutId)`, and a unique non-null
`(providerId, accountScope, paymentKind, paymentId)`. The fulfillment/outbox should also have a
unique local-order key. The service's CAS must be one conditional database update, not a read
followed by an unconditional write. Conflicts/serialization errors may retry read-only confirmation;
they never authorize replaying an external create/capture command.

Only matching actual paid money plus a payment reference and catalog/mode evidence can set
`fulfilledAt`. Initial subscriptions also require the provider subscription ID. Amounts/currencies
are compared as exact decimal strings; absent actual money is never replaced with zero or a
catalog price. Tax-exclusive, variable-price, discounted, free-trial and multi-item flows are not
silently supported: this workflow expects the exact frozen positive total. Stripe promotion codes
and automatic tax are disabled for these requests. Configure matching catalog prices/tax treatment
in the consumer or use the lower-level APIs with an explicitly richer commercial contract.

Once committed, `fulfilledAt` prevents duplicate grants from simultaneous returns, webhook
replays and later pending/unpaid observations. This is local transaction atomicity, not a claim
of exactly-once external delivery. Subscription-cycle grants must use a separate unique cycle key;
initial checkout completion must not also grant the first period through a second event handler.
Creem refunds retain the separate full-remaining protocol above; this service does not turn it
into the legacy partial-refund interface.

### Hosted workflow verification

Synthetic port/adapter tests cover persisted dispatch, restart-safe unknown outcomes, foreign owner
and checkout rejection, exact money/catalog validation, pending/trial evidence, explicit capture,
concurrent return/webhook fulfillment and rollback/retry after a failed entitlement write. Provider
tests verify catalog IDs, operation keys, original webhook bytes, read-only retrieval and separate
payment-reference kinds. These tests do not establish a real PostgreSQL transaction, provider sandbox
browser flow, real charge/refund, or published consumer integration. The additive package source
still requires a new immutable artifact for consumers that do not use the local development build.

## Subscription provider protocols

`createStripeSubscriptionAdapter`, `createCreemSubscriptionAdapter` and
`createPayPalSubscriptionAdapter` implement `SubscriptionAdapter`. They query provider facts;
applications own authenticated subscription/customer ownership, catalog policies, receipt persistence,
atomic entitlement writes and cancellation access policy. `accountScope` must distinguish merchant
credentials and environment. Do not accept a customer, invoice or subscription ID from a browser
without checking the application's durable binding first.

| Capability | Stripe | Creem | PayPal |
| --- | --- | --- | --- |
| Current subscription facts | SDK subscription/items | Subscription API | Subscriptions v1 |
| Paid service periods | Paginated paid invoices, one nonprorated subscription line | Paginated transactions filtered by customer/product, then subscription | Requires an explicit durable merchant period receipt |
| Paid receipts without a period claim | Use period API | Use period API | `listPaidReceipts`, actual COMPLETED transaction gross amount |
| Cancel now | Yes, then GET | Yes, then GET | Yes, then GET |
| Cancel at period end | Native | Native scheduled cancellation | Unsupported; no fabricated schedule |
| Customer billing portal | Customer-bound portal session | Customer-specific billing link; no return URL parameter | Unsupported; a generic account URL is not a portal session |
| Invoice lookup/link | Native invoice/hosted URL | No documented invoice API in this adapter | No fabricated invoice or generic activity link |

`listPaidPeriods(id, { cursor? })` returns `SubscriptionPaidPeriodPage`: stable `recordId`, provider
subscription/catalog identity, explicit start/end, exact **actual** `paidMoney`, payment ID/kind and
paid timestamp. Follow `nextCursor` until exhausted; the latest subscription payment cannot recover
multiple offline renewals. Cursors are scoped to adapter account and subscription. Missing or ambiguous
facts are returned as `issues`, never silently converted into entitlement evidence. Invoice proration,
multi-item invoices and missing periods require a richer application policy; the adapter does not
assign a full invoice's paid amount to an arbitrary line. Historical Creem product identity comes from
the provider-side product filter, while returned customer/subscription identity is checked.

All cancellation methods return **re-queried** `SubscriptionDetails`. A successful mutation followed
by an unchanged/unknown provider status stays unchanged/unknown; a failed re-query rejects. Consumers
must not display cancellation success from HTTP acceptance alone. `verifyWebhook` verifies original
request bytes and returns only event/subscription correlation; retrieve current facts before writing
entitlements. No adapter retries a mutation automatically.

### PayPal evidence and explicit entitlement choices

PayPal Subscriptions v1 transactions expose transaction ID, processing time, status and actual gross
money, but no service-period boundaries or cycle ordinal. `start_time`, current plan frequency,
`cycle_executions`, `last_payment` and `next_billing_time` do not reconstruct historical pause, retry,
change or outstanding-balance assignments. Neither sorting transactions nor adding a month to payment
time proves a paid service period.

Choose explicitly between:

- **Per-payment policy:** use `listPaidReceipts` and atomically deduplicate `(provider, accountScope,
  subscriptionId, paymentKind, paymentId)` before granting. This means each distinct completed charge,
  not each presumed calendar cycle; two charges for the same unknown cycle are not automatically merged.
- **Per-period policy:** provide `resolvePeriodReceipt` backed by durable merchant billing evidence.
  Its returned account/subscription/plan/payment identities and period are validated. Return `null` for
  missing evidence. Do not infer receipts from payment time or transaction ordering.

`capabilities.paidReceiptProof` and `paidPeriodProof` expose those differences before showing actions.
With no receipt resolver, PayPal still supplies paid receipts, lifecycle reads, creation and cancellation;
its period API reports `missing_period`. Its receipt traversal freezes the scan end, walks bounded
31-day windows from creation and follows validated same-environment page links. Adjacent windows can
repeat a boundary receipt, so durable receipt deduplication is required. `PAID`, catalog prices,
subscription ACTIVE status, last-payment summaries and pending/refunded transactions cannot replace
COMPLETED transaction money.

Protocol regression uses injected Stripe SDK methods and PayPal/Creem fetch implementations. It covers
multiple pages and offline windows, real-money fields, missing evidence, rejected foreign identities,
verified webhooks, cancel/re-read outcomes, malicious pagination and sanitized transport errors.
No test calls a real provider account or establishes real charge/refund behavior.

Protocol sources: [Stripe invoices](https://docs.stripe.com/api/invoices),
[Stripe billing portal](https://docs.stripe.com/api/customer_portal/sessions/create),
[Creem transaction and portal reference](https://docs.creem.io/skills/creem-api/REFERENCE),
[PayPal subscription creation](https://developer.paypal.com/api/subscriptions/v1/subscriptions-create),
[PayPal subscription transactions](https://developer.paypal.com/api/subscriptions/v1/subscriptions-transactions),
[PayPal cancellation](https://developer.paypal.com/api/subscriptions/v1/subscriptions-cancel).

## Typed refunds for hosted payments and subscription receipts

`createStripeRefundAdapter`, `createPayPalRefundAdapter` and `createCreemRefundAdapter` consume
`RefundPaymentReference { paymentKind, paymentId, paidMoney }`. The reference and actual paid money
must come from the application's verified order or immutable subscription receipt, not the browser.
This protocol does not copy an order schema or change the original payment/fulfillment history.

| Protocol | Supported references | Partial refunds | Provider request idempotency | Read a refund | Enumerate refund receipts |
| --- | --- | --- | --- | --- | --- |
| Stripe | PaymentIntent; invoice with one attributable settled funding source | Yes | Persisted command key | Yes | Scoped, cursor-paginated `listRefunds` |
| PayPal | Captured payment; subscription sale transaction | Yes | Persisted command key (sale limit: 78 characters) | Separate v2 capture/v1 sale refund APIs | No native list claimed |
| Creem | Transaction | No; exact full remaining amount only | Not documented; never retry the mutation | No native refund lookup claimed | No native list claimed |

Call `retrievePayment(reference)` to verify captured money and resolve the actual `source`. For Stripe
invoices, the adapter enumerates invoice payments and follows their PaymentIntent or charge; it rejects
multiple sources, external payment records and an intent amount that cannot be attributed to the single
invoice. An invoice ID is never passed as a charge or PaymentIntent. An original subscription sale ID
is never passed to PayPal's capture-refund endpoint.

`create({ payment, money, commandKey, reason? })` sends one explicit full or partial refund command.
Money uses exact decimal strings. The adapter snapshots caller input, validates currency and amount,
and never automatically repeats a mutation. A successful command response must match the requested
amount and original funding source. Pending, requires-action, failed, canceled and unknown responses
remain distinct. Missing or zero actual refund money cannot establish success. `RefundProtocolError`
contains a redacted message plus an `outcome` of `rejected` or `unknown`; an unknown response never
means no refund occurred.

The `RefundObservation.source` is the real provider funding identity (for example, a Stripe charge)
while `paymentId/paymentKind` preserve the local verified reference (for example, its invoice).
`money` is this refund's actual amount. Optional `totalRefundedMoney` is the provider's cumulative
amount; **never add it as another refund receipt**. Optional aggregate fields on `retrievePayment`
remain absent when the provider cannot establish them. PayPal partial capture/sale status does not
provide a complete pending-refund history or an exact partial-refund total by itself.

Stripe records the server command key in controlled refund metadata; PayPal uses capture `custom_id`
and sale `invoice_number`. Query and webhook observations expose this optional `commandKey` to correlate
an accepted command after a lost response. The original payment, amount, environment and provider
refund ID still require validation. Do not match requests by similar amount or timestamp. Stripe's
`listRefunds` uses account/payment-scoped cursors and lets a consumer recover multiple offline refunds
without dispatching another command. PayPal sale endpoints remain the documented v1 sale protocol;
this does not migrate a sale into a v2 capture or introduce Braintree.

Creem's create endpoint only promises a status acknowledgement. When no actual refund ID/amount is
returned, `refundId`/`money` stay absent and a bare `succeeded` status is retained as `providerStatus`
with normalized state `unknown`. A consumer retains its durable command, then reconciles signed
`refund.created` evidence and/or the transaction's actual cumulative refunded amount. Never invent a
refund ID, use the expected amount as actual refund money, or replay an unknown Creem request.
Creem's signed refund events can describe partial refunds performed outside this API even though its
command API supports only full remaining refunds.

`verifyWebhook` authenticates original bytes before exposing event/receipt/source facts. Stripe's
refund events are checked against the configured live/test mode; PayPal validates its configured
webhook and original payment links against the configured environment; Creem reuses the existing HMAC
and mode checks. Unrelated events return null. Lifecycle notifications are not refund facts, and a
refund does not automatically cancel a subscription.

### Durable application integration

The application owns refund permission, target ownership, frozen policy, and how refunded credits are
reserved/reversed. Persist the command and its target payment identity before dispatch; use a durable
CAS claim and a provider/merchant/environment namespace. Keep provider IO outside database transactions.
Apply a verified refund receipt, its cumulative accounting, entitlement reversal/release and outbox
in the same transaction, under the same account lock as consumption. Persist a unique provider refund
identity and reject conflicting evidence. Keep financial settlement separate from entitlement recovery,
including an already-spent/expired credit policy. This package's protocol alone does not make those
consumer persistence and recovery steps complete.

Focused tests use injected SDK/fetch providers for full/partial refunds, invoice funding and pagination,
exact amounts, pending and unknown states, lost responses, correlation, malicious parent links,
verified webhooks and error redaction. No real payment/refund or provider-account call is part of these
tests. Existing consumers still need an authorized immutable package artifact before rollout.

Protocol references checked 2026-10-24: [Stripe refunds](https://docs.stripe.com/api/refunds/create),
[Stripe invoice payments](https://docs.stripe.com/api/invoice-payment/list),
[PayPal capture refunds](https://developer.paypal.com/api/payments/v2/captures-refund),
[PayPal sale refunds](https://developer.paypal.com/api/deprecated/payments/v1/sale-refund),
[PayPal v2 schema](https://developer.paypal.com/api/payments/v2/schema.json),
[PayPal sale schema](https://developer.paypal.com/api/deprecated/payments/v1/schema.json),
[Creem full-remaining refunds](https://docs.creem.io/api-reference/endpoint/refund-payment),
[Creem signed refund events](https://docs.creem.io/skills/creem-api/WEBHOOKS).

## Subscription plan catalog and user subscriptions

Plans are the single source of what is sold and at what price. `PlanCatalogStore` is the persistence
port for database-backed plans: `slug`, `name`, `description`, listed `status`, `order`,
`features`, `quotas`, a `revision` incremented by every write, and `prices: PlanPrice[]` where each
price is `{ interval: 'month' | 'year' | 'one_time' | 'lifetime', currency, amount, termDays,
providerRefs }` (`amount` is an exact decimal string; `termDays` only for `one_time`;
`providerRefs` maps a provider id to its catalog reference, e.g. a Stripe Price ID). Types come from
`@zucker-framework/fe-types/back-office` (`SubscriptionPlanRecord = SubscriptionPlan<Date>`).

`PlanCatalogService` validates writes with `validatePlanWrite`/`validatePlanPrices` (unknown fields,
slug format, amounts only as strings with the currency's precision, unique `(interval, currency)`,
provider reference formats — `stripe` must be a `price_…` ID, others are opaque) and delegates
`{features, quotas}` to the injected `validateGrant` — normally `validatePlanGrant` from
`@zucker-framework/credit`. `update` accepts `expectedRevision` (stale → `conflict`). The store
enforces slug and provider-reference uniqueness (one reference sells one price) and refuses to
delete referenced plans atomically. Errors are branded `PlanCatalogError`s with reasons
`invalid` / `not_found` / `conflict` / `referenced`.

Checkout: `planOfferId(planId, interval, currency)` names a plan price as an offer
(`plan:<planId>:<interval>:<currency>`, never colliding with static offer ids). `resolveOffer(offerId,
providerId)` returns the listed plan's current price for that provider (positive amounts only),
`planCheckoutMode(interval)` (`month`/`year` → `subscription`, others → `payment`) and a
`PlanPriceSnapshot` to freeze on the order. Write-back reads it back with `readPlanPriceSnapshot` and
uses its `planId` — never a slug or provider-reference lookup.

`SubscriptionAssignmentService` keeps one current subscription per user through
`UserSubscriptionStore`, whose `transaction(userId, …)` must hold the same account lock as payment
fulfillment. `assign` (administrator assign/modify/revoke; omitted dates keep a live same-plan term,
a lapsed term starts over, `ONE_TIME` needs an explicit end, LIFETIME has none and cannot be
`CANCELED`), `cancel` (keeps the paid end date; LIFETIME is refused — revoke it with `EXPIRED`) and
the payment write-back `recordPayment`. Every payment reference is recorded once through
`recordPaymentEvidence` (the payment ledger); the result's `outcome` is `applied`, `replayed`,
`ended` (period already over: evidence only), `superseded` (a recurring period the live same-plan
term already covers, or evidence older than the evidence defining another plan's term), `kept` (an
active LIFETIME term, or a longer administrator-granted term of another plan, is never shortened or
replaced) or `revoked` (an administrator revoked the term at or after the payment's `purchasedAt`).
A same-plan `ONE_TIME` payment is stacked: the term is extended from max(now, current end) by the
paid duration, while the ledger keeps the paid period itself. `admitPurchase(userId, { planId,
billingCycle, termDays })` applies the same precedence at checkout, before an order exists, and
refuses (`conflict` with `details.refusal`: `lifetime_active`, `longer_admin_term`,
`term_covers_purchase`; `pending_payment` with `provider_subscription` while a provider plan
subscription bills) every purchase whose payment would be recorded without improving the term. A
checkout payment that still ends `kept`/`superseded`/`revoked` means the term changed between
checkout and payment; flag it for a refund. Administrator changes are refused with
`pending_payment` while `pendingPayment` returns the blocking order or provider subscription (it is
returned as `details.blocking`); revocation (`EXPIRED`) and `cancel` are refused only by a provider
subscription, not by an unsettled checkout. Validity comes from the injected `activeTerm` predicate (pass `isActiveTerm`
from credit). `changed` runs after `assign`/`cancel` commit; `recordPayment` runs inside the caller's
payment transaction and returns its `change` for the caller to publish after commit (for example
through its outbox).
`revokePayment({ userId, reference })` is the refund write-back: call it once, in the refund settlement
transaction, when a payment was refunded in full (a partial refund keeps the term). Only a live term
whose `paymentReference` is that payment changes: LIFETIME is revoked (`EXPIRED`), a stacked
`ONE_TIME` term loses the paid duration, a recurring term falls back to the start of the refunded
period; an end that is not in the future revokes the term (`EXPIRED`, end now). Outcomes: `revoked`,
`shortened`, `not_current` (another payment, plan or administrator defines the term), `inactive`,
`not_found`. The evidence stays recorded, so the refunded reference is never applied again; the
returned `change` (`kind: 'refunded'`) is published by the caller after commit.
