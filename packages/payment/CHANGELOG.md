# @zucker-framework/payment

## 1.0.16

### Patch Changes

- @zucker-framework/core@1.0.16

## 1.0.15

### Patch Changes

- @zucker-framework/core@1.0.15

## 1.0.14

### Patch Changes

- @zucker-framework/core@1.0.14

## 1.0.13

### Patch Changes

- @zucker-framework/core@1.0.13

## 1.0.12

### Patch Changes

- @zucker-framework/core@1.0.12

## 1.0.11

### Patch Changes

- @zucker-framework/core@1.0.11

## 1.0.10

### Patch Changes

- Add a dependency-free Creem catalog Checkout adapter with explicit test/production configuration, raw-body HMAC webhook verification, read-only checkout/transaction/subscription observations, explicit cancellation, and the provider's supported full-remaining refund operation. Keep pending and unknown outcomes distinct, never invent payment amounts or refund receipt IDs, and do not automatically retry mutations.

  Expose neutral subscription lifecycle/period/payment observations and a deterministic namespaced period key for consumer-owned transactional grant receipts. Document how existing order stores consume the hosted observations and why the catalog adapter is not a drop-in amount-based OrderService provider. No product pricing, entitlement policy, persistence migration or live payment calls are added.

- Add a durable hosted-checkout workflow with frozen server-side catalog offers, ownership/account
  binding, persistent create/capture claims, verified provider reconciliation and transactional
  initial fulfillment, including a private immutable JSON snapshot of consumer entitlement policy.
  Freeze separately validated public provider metadata for supported Stripe/Creem attribution;
  reject reserved correlation overrides and unsupported PayPal metadata before external dispatch.
  Add Stripe, PayPal and Creem catalog adapters with explicit capability and
  payment-evidence boundaries; preserve the existing amount-based order/refund contracts.
  Reject a known payable-amount mismatch before exposing a checkout URL, and include the
  Stripe session return hint for owner-scoped, provider-verified unknown-outcome recovery.
- Preserve legacy paid order state after a successful partial refund and return a partial-refund observation instead of claiming the entire payment was refunded. Validate requested refund money before claiming the order. Resolve PayPal Orders v2 references to a unique refundable capture before calling the capture refund endpoint, preserving the existing PaymentSession reference contract.
- Use the subscription invoice as the hosted checkout receipt even when Stripe also supplies its payment intent, keeping the initial purchase aligned with renewal fulfillment. Incomplete subscription invoice evidence remains unresolved instead of binding a different payment identity.
- Add provider subscription protocols for Stripe, Creem and PayPal, with paginated actual-money
  receipts, explicit provider-period evidence, verified lifecycle webhook correlation, cancel-and-read
  behavior, supported customer portal/invoice operations and capability declarations. Extend PayPal
  hosted checkout to existing fixed-price subscription plans with durable creation keys and initial
  transaction reconciliation. PayPal per-payment evidence remains distinct from service-period proof;
  applications must explicitly choose entitlement policy or provide durable period receipts.
- Add typed refund adapters for Stripe, PayPal and Creem using verified payment-kind identities and
  actual decimal money. Support native full/partial refund commands, attributable Stripe invoice
  funding, separate PayPal capture/sale protocols, refund queries and verified webhook evidence.
  Expose explicit channel capabilities, scoped Stripe refund pagination, server command correlation,
  separate cumulative refund totals and safe status-only/unknown outcomes. Keep provider IO and
  protocols independent from consumer-owned refund permissions, durable command claims and ledger holds.
- Add optional verified-payment preparation before hosted-checkout fulfillment transactions, allowing consumers to retrieve and persist refund evidence without performing provider I/O under ledger locks. Fulfillment adapters must still enforce persisted restrictions in the delivery transaction.
- @zucker-framework/core@1.0.10

## 1.0.8

### Patch Changes

- @zucker-framework/core@1.0.8

## 1.0.7

### Patch Changes

- @zucker-framework/core@1.0.7

## 1.0.6

### Patch Changes

- @zucker-framework/core@1.0.6

## 1.0.5

### Patch Changes

- Updated dependencies
  - @zucker-framework/core@1.0.5

## 1.0.3

- Add `PaymentProviderAdapter`, the neutral `SettlementState` model with `reconcile()`, decimal-string `Money` helpers (`toMinorUnits` / `fromMinorUnits`, zero-decimal currencies), `PaymentNextAction`, `createPayPalAdapter` / `createStripeAdapter`, the `checkPaymentAdapterContract` suite and `createFakeAdapter`. Webhook input is raw bytes plus all request headers; authorization and capture are separate steps; `retrieve` is read-only.
- Decode PayPal v2 refund capture links and reversal identities, reject failed refund HTTP responses while preserving pending refunds, and accept a stable refund request identifier. `PayPalCaptureRefundRequest.amount` is optional (omit for a full refund). `createStripeCheckoutSession` accepts `Stripe.RequestOptions` for idempotency keys.
- Remove the legacy `PaymentProvider` / `PaymentService` / `PaymentIntent` / `CreatePaymentParams` / `PaymentResult` / `RefundResult` / `WebhookEvent` / `PaymentStatus` / `Subscription` / `SubscriptionPlan` / `SubscriptionProvider` exports. They had no implementation inside the framework and no consumer since publication; `ZuckerPaymentModule`'s `providers` option now takes `PaymentProviderAdapter`. Published as a scoped patch because no released consumer references the removed names.

## 1.0.2

### Patch Changes

- c0de08f: Expose hosted Checkout and payment-intent operations with raw provider results and normalized settlement, expandable resource IDs and payment-method evidence. Add PayPal order creation/capture/read observations and verified-webhook payload decoding with required capture identity.

  Provider reads remain read-only. Nonterminal/approved evidence stays unknown; only an explicit capture operation charges. Requests, SDK versions, product metadata, currency/price policy, redirects and fulfillment remain owned by the consumer. No refund activation or storage migration is included.

- c0de08f: Expose explicitly configured Stripe client/signature primitives and PayPal SDK/OAuth/webhook/refund transport. Keep the generic PaymentProvider interface unchanged; consumer order, product, amount/currency, entitlement and fulfillment policies remain outside Framework. Stripe and PayPal SDKs are optional peers, loaded on use without upgrading the consumer's versions.
- c0de08f: **Breaking API changes in the maintainer-selected unified 1.0.2 release.** Review the migration requirements below before upgrading; the shared patch version does not imply backward compatibility for this entry.

  Require explicit asynchronous order persistence and remove the OrderService in-memory store. Export OrderPersistence and DatabaseOrderPersistence over the existing database model port, including one-statement conditional state updates without money/JSON/date conversion or implicit transaction creation.

  Make formerly synchronous order/recovery reads and cancellation asynchronous. Claim confirmation/refund transitions before provider calls; retain unknown outcomes, including pending/processing confirmation responses, for reconciliation rather than automatically issuing another charge. Preserve refunded confirmation results as terminal. Surface provider-link persistence failures. ZuckerPaymentModule requires orderPersistence.

  Replace in-memory recovery counts with a required atomic RecoveryAttemptStore contract when sending recovery mail. Reserve before sending, forward a stable attempt idempotency key and propagate persistence failure. There is no default recovery table or memory fallback.

  CNIPA consumes the public persistence contract on its existing PostgreSQL order model and transaction clients. Product states, prices, records and fulfillment remain consumer policy. Regression and PostgreSQL contract sources are prepared but verification, dependency integration and publication remain pending.

- Align all public Framework packages to the maintainer-selected 1.0.2 release and keep subsequent releases synchronized through a Changesets fixed group. Package dependencies and the CLI scaffold catalog follow the same version.

  This release consolidates the pending API migrations, including breaking auth and payment persistence contracts. Review docs/package-release-1.0.2.md before upgrading from 1.0.0 or 1.0.1.

- Updated dependencies [c0de08f]
- Updated dependencies [c0de08f]
- Updated dependencies [c0de08f]
- Updated dependencies [c0de08f]
- Updated dependencies
- Updated dependencies [c0de08f]
  - @zucker-framework/core@1.0.2

## 1.0.0

### Major Changes

- First stable public release under the @zucker-framework organization. Publish compiled JavaScript, public type declarations, required runtime assets and Apache-2.0 license materials without source maps.

### Patch Changes

- Add Apache-2.0 license files, framework attribution, bundled third-party notices,
  and public npm publishing metadata to every library. Validate these materials
  in package contents before upload and declare required and optional runtime dependencies.
- Harden framework runtime packaging and public error handling, add controller and global-guard registration controls, unify the database adapter token, bound monitoring samples, expose portable metrics and uptime helpers, redact email delivery logs, and protect rate-limit storage keys.
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @zucker-framework/core@1.0.0
