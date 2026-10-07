# @zucker-framework/payment

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
