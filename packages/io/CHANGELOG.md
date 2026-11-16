# @zucker-framework/io

## 1.0.22

## 1.0.21

## 1.0.20

### Patch Changes

- Billing, credit, back-office, notification, licensing and import/export fixes.

  **credit**
  - `CreditService` balance changes lock the account row before reading it, so concurrent consumes can no longer double-spend and concurrent grants are no longer lost; transfers lock both accounts in a stable order and read them only after both locks are held (safe under MySQL REPEATABLE READ too).
  - `grant`, `consume`, `refund` and `exchange` take an optional last argument `{ idempotencyKey }` (stored in `creditOperationReceipts`; the model must exist when keys are used). Reuse with different parameters (account, operation, amount or `orderId`) fails with 409 `CREDIT_IDEMPOTENCY_CONFLICT`, also when the key is used concurrently on another account. With a key, `amount` must be an integer from 1 to 2,147,483,647 (400 otherwise).
  - Credit events are published after commit (also for freeze/unfreeze/expiry); a failing event bus is logged and no longer fails or rolls back the mutation.
  - `checkExpired()` removes only the unspent remainder of an expiring grant (earliest-expiring credits are spent first), never non-expiring credits; each grant is expired once even with concurrent sweeps; unprocessable grants no longer block later ones. New EXPIRE rows carry the expired grant id in `orderId`. Due grants are grouped per account and the ledger is replayed once per account. REFUND, UNFREEZE and TRANSFER_IN credits never expire, so consume-then-refund or freeze-then-unfreeze turns expiring credits into permanent ones (documented, in the user's favour).
  - BREAKING (behaviour): `BatchCreditLedger.expire` pages its scan and continues past failing accounts, then throws a `CreditExpiryError` (an `AggregateError` listing the failures, with the expired total in `expired`) instead of stopping at the first failure. A custom `scanLots().findMany` must honour `orderBy: [{ id: 'asc' }]`, `take` and the `where.id.gt` cursor; a scan that ignores them still terminates. Hold replays accept a store that returns `null` for an absent `resourceId`.

  **admin**
  - BREAKING (security): `PUT /users/:id` and `POST /users` accept only allow-listed fields (`name`, `locale`; plus `password`, `email`, `emailVerified`, `status`, `typeId`; plus `username` on create). Other keys get 400. Changing `password`/`email`/`emailVerified`/`status`/`typeId` additionally requires `users:authorize` (unchanged values resent by fe-admin are fine). Accounts holding `superadmin` can only be updated, re-roled, re-permissioned or deleted by a superadmin. Granting superadmin (a role named `superadmin` or inheriting from one, or a `superadmin`/`*` permission link) through `PUT /users/:id/roles`, `PUT /users/:id/permissions`, `POST /roles` or `PUT /roles/:id` (rename, `parentId`, `permissionIds`) also requires a superadmin. `creatorId` comes from the authenticated actor. Migration: list consumer columns in `ZuckerAdminModule.forRoot({ users: { writableFields, readableFields } })`.
  - BREAKING (response): user routes return an explicit field projection (`id, username, name, typeId, status, email, emailVerified, locale, creatorId, createTime, createdAt, updatedAt`); add other columns via `users.readableFields`.
  - New `users.hooks` (`AdminUserHooks.sensitiveFieldsChanged` / `userDeleted`) so applications can revoke sessions after back-office password, e-mail or status changes.
  - `PUT /users/:id/permissions` and `/dimensions` validate the body, lock the user, and permissions replace only links of the given `grantType`. Deleting a user no longer fails on PostgreSQL when the optional `dimensionUsers` table is missing.
  - `PUT /users/:id` no longer re-inserts a user deleted concurrently, and `''` sent for a field stored as `null` (e.g. `email`) is not a sensitive change.
  - BREAKING (request): the form definition list honours `$like`/`$eq` filters and rejects unknown filter keys with 400. Notification history pages beyond 100 records with a correct total.

  **payment**
  - BREAKING (amounts): KWD/BHD/JOD/OMR/TND use three decimals and Stripe UGX/ISK conversion is correct on every Stripe path (the legacy adapter undercharged these currencies). `currencyExponent`, and with it `toMinorUnits`/`fromMinorUnits`, throws on a currency that is not three letters instead of assuming two decimals. `normalizePlanAmount` requires three decimals for those currencies; plan price snapshots stored with two decimals before 1.0.20 are still accepted by `readPlanPriceSnapshot`. New `toStripeMinorUnits` / `fromStripeMinorUnits`.
  - BREAKING (webhook): legacy Stripe/PayPal webhooks report partial refunds as `partially_refunded`; Stripe `charge.refunded` uses the Checkout Session (or undefined) as `providerRef`, not the charge id. PayPal `PAYMENT.CAPTURE.REFUNDED` derives the state from the order, resolved through the refund's `up` capture link when the event carries no order id, and reports `unknown` when that fails.
  - Retrying a Stripe refund command whose response was lost returns the existing refund instead of a rejection.
  - BREAKING (behaviour): new `OrderService.reconcileOrder` and `resolveRefund`; `created`/`authorized` capture answers return the order to `paying` (previously it stayed `confirming`). A definite 4xx capture or refund rejection is checked with a read-only `retrieve` before the order is released: a capture reopens `paying` only on `created`/`authorized` (PayPal 422 `ORDER_ALREADY_CAPTURED` now records `paid` instead of a cancellable `paying`), a refund returns to `paid` only when nothing was refunded, and an unreadable outcome stays `confirming`/`refunding`; the original error is still thrown. Refund bookkeeping lives in `Order.metadata` (`zucker.pendingRefund`, `zucker.partialRefundCount`; not sent by `retryOrder`); `reconcileOrder` accepts `partially_refunded` as the pending refund's outcome only when no earlier partial refund was recorded, otherwise the order stays `refunding` for `resolveRefund`. New `partialRefundCount`, `pendingRefund`. `retryOrder` accepts description and return/cancel URLs. New `PaymentRejectedError`, `isDefinitePaymentRejection`.
  - New `HostedCheckoutService.resetDispatch` and `onPaymentMismatch` option; definite provider rejections release create/capture claims.
  - BREAKING (behaviour): PayPal calls, including `PayPalPaymentTransport` SDK create/capture/get-order, time out after `timeoutMs` (default 10 s; previously no timeout). Treat a timeout as an unknown outcome and reconcile; non-JSON refund failures surface as HTTP failures.
  - BREAKING (behaviour): `PaymentRecoveryService` sends no mail unless `frontendUrl` or a URL generator is configured and never includes raw provider error messages.

  **notification**
  - BREAKING (behaviour): `CompositeNotifierService` no longer hands one channel's addresses to another channel; supply `fallbackRecipients` per channel to keep cross-channel fallback. `to` is passed through as given. Partial SMS batch failures throw `PartialNotificationDeliveryError` and only failed recipients are retried; a partial-delivery error that lists no failed recipient counts as delivered.
  - The durable worker no longer re-sends a delivered message when saving the delivered state fails: the commit is retried twice with a backoff (200 ms, 1 s) bounded by the remaining lease, then `runOnce` throws and delivery stays at-least-once once the lease expires.
  - `NotifierEventDispatcher` publishes the error topic for `{ success: false }` results.
  - SMS logs mask phone numbers; Tencent keeps E.164 numbers (`defaultCountryCode`, `templateParamOrder`); SMS providers time out (`timeoutMs`, default 10 s).
  - `WebhookRegistry.verify` accepts `sha256=` values; 408/429 are retried; endpoints dispatch in parallel.
  - BREAKING (rendering): a variable at the start of a mail template URL attribute (`href`, `src`, `action`, ...) must be http/https/mailto; `href` also accepts `tel:` and `src` accepts `cid:` and base64 `data:image/png|jpeg|gif|webp`. Other values, including relative paths, render `#` (also in database-stored templates). Text variables are no longer rewritten.
  - Resend bounces suppress only hard bounces of single-recipient messages; the mail campaign start-up reaper is safe with several workers. Campaign progress, completion and failure writes require the campaign to be `running`, so a sender whose BullMQ job was re-delivered while it was still alive stops at its next batch instead of completing a campaign marked failed. New `NotifyHistoryService.count()`.

  **i18n / form / dictionary**
  - `LocaleInterceptor` selects region-qualified locales such as `zh-CN`; `FileMessageSource` rejects malformed locale values.
  - Form definitions are cached for 30 s. BREAKING (validation): invalid patterns and patterns with a nested variable quantifier (`(a+)+`, `(x|y+){2,}`) are rejected on save, and stored forms that already contain one fail validation of every value instead of a 500; a fixed inner count such as `^(?:\d{4})+$` is allowed. Each pattern test runs with a 50 ms limit in a `node:vm` context (catches `(a|a)*$`, `(.*a){20}`); a timed-out test rejects the value. New `compileFormPattern`, `testFormPattern`, `FORM_PATTERN_TIMEOUT_MS`.
  - Dictionary import counts are accurate and import clears the cache and emits change events.

  **ext-server**
  - The Stripe webhook claims the order before minting a licence, so concurrent or retried deliveries create and e-mail at most one licence; orders stay `email_failed` until delivery succeeds. New optional `ExtStore.$transaction` makes fulfilment, activation and resend atomic, and activation locks the licence so parallel devices cannot exceed `maxDevices`.
  - New optional `options.checkout` allow-list (`requireProductMetadata`, `allowedProducts`, `allowedPaymentLinks`, `accept`); without it behaviour is unchanged, and a start-up warning is logged when `stripeWebhookSecret` is set.
  - `adminResendOrder` delivers the new code before revoking the old one and revokes the new code if delivery fails; the final step locks and re-reads the order, so concurrent resends leave exactly one active licence.
  - A unique violation is answered as a duplicate delivery only when it is on the order's `stripeSessionId` (or the error names no key and the order row exists); others, such as a licence `codeHash` collision, are rethrown so Stripe retries.
  - New `options.activationExpiry: 'per-device' | 'license'` (default unchanged).
  - BREAKING (minor): the constructor rejects an empty `licenseSecret`. New licence previews show `PREFIX-…XY`; admin paging is clamped to 1–100; ids over 256 characters get 400.

  **io**
  - CSV import decodes multi-byte UTF-8 split across chunks and stops at `maxRows`. BREAKING (behaviour): `importFromCsv` throws on a record longer than `maxRecordLength` (default 1,048,576 characters), and missing required columns (CSV and Excel) are reported on every row.
  - BREAKING (output): `exportToCsv` prefixes formula-like cells with `'` by default; pass `escapeFormulas: false` for the old output.
  - `detectFormatFromBuffer` recognises CSV starting with a BOM or non-ASCII text.

## 1.0.19

## 1.0.18

## 1.0.17

## 1.0.16

## 1.0.15

## 1.0.14

## 1.0.13

## 1.0.12

## 1.0.11

## 1.0.10

## 1.0.8

## 1.0.7

## 1.0.6

## 1.0.5

## 1.0.2

### Patch Changes

- Align all public Framework packages to the maintainer-selected 1.0.2 release and keep subsequent releases synchronized through a Changesets fixed group. Package dependencies and the CLI scaffold catalog follow the same version.

  This release consolidates the pending API migrations, including breaking auth and payment persistence contracts. Review docs/package-release-1.0.2.md before upgrading from 1.0.0 or 1.0.1.

- c0de08f: Extract consumer-independent cancellation scopes, per-chunk idle timeouts, bounded concurrency admission and timezone helpers; reuse cancellation in the AI adapter. Add signed browser-bound OAuth state, login audit with transactional counters, device parsing and configurable Passport guards. Authorization guards can deny provider errors and select a safe log identity without rewriting request.user.

  Add a validated HTTP query DTO without changing QueryParamEntity. MetadataLogService reuses log persistence for explicitly projected metadata. The optional ai/langchain entry captures call timing and usage without forcing LangChain on other AI consumers.

  Add the single-process task supervisor and temporary export artifact manager. Both preserve their process-local scheduling boundaries: neither introduces durable task storage, distributed leases or multi-executor safety. Consumers retain state transitions, ownership, retry eligibility, prompts, budgets, messages, retention schedules and output policy.

  Source migration only: new APIs, independent test sources and consumers are prepared; verification and immutable publication remain separate pending stages.

  Add durable recipient inbox operations and bounded verified object transfer; retain recipient constraints in updates, reject content collisions, keep dry runs read-only and verify uploaded object bytes before success.

## 1.0.0

### Major Changes

- First stable public release under the @zucker-framework organization. Publish compiled JavaScript, public type declarations, required runtime assets and Apache-2.0 license materials without source maps.

### Patch Changes

- Add Apache-2.0 license files, framework attribution, bundled third-party notices,
  and public npm publishing metadata to every library. Validate these materials
  in package contents before upload and declare required and optional runtime dependencies.
