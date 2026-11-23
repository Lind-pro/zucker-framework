# @zucker-framework/credit

## 1.0.30

### Patch Changes

- @zucker-framework/core@1.0.30
  - @zucker-framework/fe-types@1.0.30

## 1.0.29

### Patch Changes

- @zucker-framework/core@1.0.29
  - @zucker-framework/fe-types@1.0.29

## 1.0.28

### Patch Changes

- @zucker-framework/core@1.0.28
  - @zucker-framework/fe-types@1.0.28

## 1.0.27

### Patch Changes

- @zucker-framework/core@1.0.27
  - @zucker-framework/fe-types@1.0.27

## 1.0.26

### Patch Changes

- @zucker-framework/core@1.0.26
  - @zucker-framework/fe-types@1.0.26

## 1.0.25

### Patch Changes

- @zucker-framework/core@1.0.25
  - @zucker-framework/fe-types@1.0.25

## 1.0.24

### Patch Changes

- @zucker-framework/core@1.0.24
  - @zucker-framework/fe-types@1.0.24

## 1.0.23

### Patch Changes

- @zucker-framework/core@1.0.23
  - @zucker-framework/fe-types@1.0.23

## 1.0.22

### Patch Changes

- @zucker-framework/core@1.0.22
  - @zucker-framework/fe-types@1.0.22

## 1.0.21

### Patch Changes

- @zucker-framework/core@1.0.21
  - @zucker-framework/fe-types@1.0.21

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

- 5280170: Launch baseline (phase 1): plans that grant credits, admin-editable credit packs, product policies,
  transactional mail, block-based landing pages and a `zucker create` workspace.

  **BREAKING: `GET /billing/plans` returns an object instead of an array.** The public catalog is now
  `{ plans, packs, checkout }`: `plans` is the former array (each price gains `credits` and
  `creditExpiry` (`'period'`, days or `null`), plans gain `featured`, `badge`, `highlights` and, for a
  signed-in caller, `current`); `packs` lists purchasable credit packs; `checkout` is
  `{ defaultProvider, allowProviderChoice }`. Migration: read `response.plans` where the array was used.
  A request with a valid bearer token is answered `private, no-store`; an invalid token is treated as
  anonymous. `GET /billing/currencies` is new.

  **New projects default to English.** `zucker create <name> [--locale en|zh]` (and
  `pnpm create @zucker-framework/app <name>`) chooses the default routed locale at creation time;
  the default is `en` and both locales always ship. Existing projects keep their configured locale.

  - payment / fe-types / fe-admin: plan prices carry `credits` and `creditExpiry`; plan presentation
    fields and translations (`nameI18n`, `descriptionI18n`, `badgeI18n`, `highlightsI18n`). New
    `CreditPackCatalogService`, `validateCreditPackWrite` and offer ids `plan:<id>:<interval>:<CUR>` /
    `pack:<id>:<CUR>`. fe-admin adds the Credit packs page (`/credit-packs`, `plans:*` permissions) and
    connection apply-mode badges (hot / restart).
  - credit: `consumeOrder: 'expiry_first'` draws the soonest-expiring lots first (never-expiring last);
    the default stays `'fifo'`.
  - fe-site: site documents version 2 (validator accepts v1 and v2, returns v2) with hero variants,
    logo cloud, stats, steps, testimonials, showcase, pricing, newsletter, blog list, changelog and
    media blocks; every href and image is re-checked with `safeSiteHref`.
  - fe-blocks (new): fetch-free React Server Component renderer (`BlockRenderer`) and theme registry
    (`defineTheme`, `resolveThemeBlock`, `--zb-*` tokens) for validated site documents.
  - core: `classifyAddress`, `resolvePublicAddress`, `assertPublicOutboundUrl`, `createPinnedLookup`,
    `pinnedFetch` and `createPublicFetch` (DNS-pinned, public addresses only, no redirects). The rule
    engine HTTP action uses the same implementation; its behaviour is unchanged.
  - cli / create-app (new): `zucker create` generates a pnpm workspace (`apps/server`, `apps/web`,
    `apps/admin`), Dockerfiles, Docker Compose (PostgreSQL, Redis, MinIO, Mailpit, one-shot
    migrations) and one root `.env` with generated secrets. `zucker doctor` checks key lengths,
    origins, database reachability and migration state.
  - notification: `EmailProvider` no longer attempts SMTP AUTH when user and password are both empty
    (local catchers and IP-allowlisted relays).
  - logging: persisted log values replace U+0000 (PostgreSQL rejects it in text/jsonb, which dropped
    the whole log row).

  Server template (copied by `zucker create` / `zucker init`, not versioned): hot-applied product
  policies (`account`, `billing`) with an admin Policies page; registration switch, optional email
  verification, initial role and welcome credits granted once (in the sign-up transaction, or a retry
  task committed with it); sign-up acquisition data; Resend or SMTP for account and transactional
  mail with editable templates and purchase receipts; `changelog` content kind, file-backed starter
  content (published by `pnpm account:admin`), signed Web cache revalidation; remote file imports
  through `createPublicFetch`; payment callbacks that fail verification answer 400. New scripts
  `pnpm account:role` and `pnpm content:seed`. Run `prisma migrate deploy`: the migrations are
  additive (plan credits and credit packs, account acquisition, changelog kind, starter-data markers
  and the new starter menus).

- Updated dependencies [f21f444]
- Updated dependencies
- Updated dependencies [5280170]
  - @zucker-framework/fe-types@1.0.20
  - @zucker-framework/core@1.0.20

## 1.0.19

### Patch Changes

- @zucker-framework/core@1.0.19
  - @zucker-framework/fe-types@1.0.19

## 1.0.18

### Patch Changes

- Shared back office (docs/back-office-rfc.md): plans, user subscriptions, entitlements, quota and mail
  administration, and the first release of `@zucker-framework/fe-admin` (fixed group 1.0.18).

  - `fe-types`: new `@zucker-framework/fe-types/back-office` wire contract (plans with `prices[]`,
    public plans, user subscriptions, quota and mail rows) and the single `PortErrorReason` with the
    `PORT_ERROR` brand and `readPortError`.
  - `payment`: `PlanCatalogService`/`PlanCatalogStore` with per-interval/currency `prices`
    (`month | year | one_time | lifetime`, exact decimal strings, provider references), optimistic
    `revision`, plan offers (`planOfferId`, `resolveOffer`, frozen `PlanPriceSnapshot`) and
    `SubscriptionAssignmentService` with a per-reference payment ledger and explicit precedence
    (`recordPayment` returns `{ outcome, subscription, change }`). Plan exports are explicit.
    `admitPurchase` refuses at checkout a plan purchase whose payment would not improve the term
    (`PlanPurchaseRefusal`: active lifetime, a longer administrator term of another plan, a same-plan
    term covering the first recurring period, a billing provider subscription); same-plan one-time
    terms stack from max(now, current end); `purchasedAt` keeps a term revoked after the purchase
    revoked (outcome `revoked`). Administrator revocation and cancel no longer wait for an unsettled
    checkout. `HostedCheckoutAdapter.quote` (Stripe with `client.prices`, PayPal subscription plans)
    refuses a checkout whose provider price differs from the offer before any order exists.
  - `credit`: `EntitlementService` and `ResourceChargeService` (identity includes the counter, stale
    reservations expire in the charge path, concurrent uses get `in_progress`, confirmation failures
    after successful work are reported, optional caller `tx`).
  - `admin`: plan, user-subscription, quota and mail-log controller factories over `…Port`
    interfaces; branded port errors only; users/roles/permissions list filters are allow-lists with
    database paging.
  - `common`: `HttpExceptionFilter` keeps a port error's `reason`, `issues` and `details` in `result`.
  - `fe-http-client`/`fe-auth`: keepalive cookie refresh with interrupted-exchange marker and timeout
    (`createKeepaliveCookieRefresh`, `createRefreshExchange`) and the cookie session
    (`createCookieSession`, cross-tab sync) used by `fe-admin`. `guardedRefresh` rejects with 401
    while signed out (without exchanging the cookie) and, while only a summary is held, unless the
    token's subject (`subjectOf`, default JWT `sub`) is the summary's user.
  - `fe-admin`: Radix/Tailwind back-office pages, lazy pages and locales.

  Versioning: this stays a patch of the fixed group (1.0.18). As in earlier releases (see
  docs/package-release-1.0.2.md and the scoped payment 1.0.3 release in docs/package-release.md),
  the bump is the maintainer-selected group version, not a semver promise; read the breaking notes
  below before upgrading.

  BREAKING (`@zucker-framework/admin`): the users, roles and permissions `POST …/_query` and
  `POST …/_count` filters are allow-lists (`USER_FILTER`, `ROLE_FILTER`, `PERMISSION_FILTER` via
  `toAdminWhere`). A filter key that is not listed — other columns, relation names, `AND`/`OR`/`NOT`,
  object values, operators other than `$eq`/`$like` — now fails with 400 instead of reaching the
  database. Invalid `pageIndex`/`pageSize` now throw `BadRequestException` (400 with a message)
  instead of `ValidationException` with per-field `errors`. Migration: send only the listed fields
  (use `field$like` for substring search) and read the pagination error from `message` rather than
  `errors.pageIndex`/`errors.pageSize`; products that need more filter fields wrap the controllers
  with their own allow-list.

  Server template integration points (new in this release): `BillingPlanOffers.resolve` receives the
  buyer (`ownerId`), and fulfillment hooks that write plan entitlements declare `plans: true`; a plan
  sale with no such hook fails its fulfillment transaction instead of being fulfilled without the
  entitlement. Verified plan payments that are recorded without changing the term are published as
  `billing.plan-payment-unapplied` outbox events for a refund.

  Breaking (server template and its consumers): the provider-subscription list moved from
  `GET /management/subscriptions` (`billing:query`) to `GET /management/billing-subscriptions`;
  `/management/subscriptions` is now the user plan subscription API (RFC §8.3). `fe-admin` defaults to
  the new path; products still serving the old route must set `endpoints.billingSubscriptions`.

  Migration notes: the template migration `20261109000000_back_office` adds plan/price/payment-ledger
  tables, `billing_orders.configRevision` and `quota_reservations.activeResourceKey` (replacing the
  compound resource unique index). Products with their own quota/plan tables apply the equivalent
  steps listed in RFC §5 with their own constraint names; `BILLING_CATALOG_JSON` subscription offers
  are now only plan seeds once a plan claims them. The same migration ends with an idempotent data
  step that adds the back-office permission rows and the new starter menus (under existing starter
  groups only) to installations created before this release.

- Updated dependencies
  - @zucker-framework/fe-types@1.0.18
  - @zucker-framework/core@1.0.18

## 1.0.17

### Patch Changes

- @zucker-framework/core@1.0.17

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

- Add opt-in transaction-bound credit lot holds with precise allocation, stable phase receipts and idempotent confirmation/release. Configured ledger consumption excludes held value, expiry preserves original allocation evidence while removing both free and frozen parts, and legacy unallocated freezing explicitly requires reconciliation.
- Expose transaction-bound expiry of selected owned credit lots so a host can fence expiry and its canonical journal with the task completion transaction. Existing expiry scanning reuses the same mechanism, including lots whose deadline equals the scan time.
- Route public package-root imports and requires to the existing matching ESM/CJS runtime and type artifacts. Previously, native ESM imports of these packages fell back to their CommonJS main entry, mixing auth/core provider classes with an application's ESM instances and breaking Nest dependency injection. Keep package.json metadata readable and preserve the existing main/module artifacts.

  Add a native Node regression for both module formats that checks package resolution, shared auth/guard identity and an Admin/Nest composition using a synthetic memory adapter. This does not make mixed import/require copies of a dual package interchangeable and does not replace persistent consumer validation. No service implementation, guard registration or access policy is relaxed.

  Use the CommonJS default export for eventemitter2 in config, dictionary and logging, with an explicit injection token referencing the original constructor. This fixes native ESM loading while retaining the shared Nest event emitter; no dependency is bundled or duplicated.

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

- Add transaction-bound durable quota reservation transitions with stable-id conflict checking, idempotent confirmation/release, captured-policy charging, and expiry. Consumers supply persistence/locking ports and entitlement policy; no schema or product configuration is installed automatically.
- Updated dependencies
  - @zucker-framework/core@1.0.5

## 1.0.3

- Add `revokeUnused`: transaction-bound revocation of selected unused credit lots using the existing account lock and journal, for refunds that must take back unspent credits without touching consumed ones.

## 1.0.2

### Patch Changes

- c0de08f: Add transaction-bound batch credit grants, FIFO consumption with source restrictions and allocation records, balance/journal writes, and locked remaining-amount expiry. Adapt existing model/column/transaction ports and reuse the existing account lock/operation receipt coordinator without a new schema or memory state.

  Applications retain source/type values, eligibility, billing, metadata and error responses. Preferred sources cannot bypass allowed sources. Independent test sources are included but have not been executed during the consumer's verification pause.

- c0de08f: Add QuotaCapacity and its transaction-bound storage contract for shared quota checking and conditional consumption. Preserve existing usage when updating configured limits, count current unexpired and unknown-period legacy reservations conservatively, and surface capacity/input/persistence failures without business event or subscription policy.

  CNIPA maps its existing quota models and transaction lock, retaining plan lookup, cycle names and post-commit events. Its checks and consumption now use the same reservation semantics. No schema or data migration, provider operation, dependency installation or runtime verification was performed.

- Align all public Framework packages to the maintainer-selected 1.0.2 release and keep subsequent releases synchronized through a Changesets fixed group. Package dependencies and the CLI scaffold catalog follow the same version.

  This release consolidates the pending API migrations, including breaking auth and payment persistence contracts. Review docs/package-release-1.0.2.md before upgrading from 1.0.0 or 1.0.1.

- Updated dependencies [c0de08f]
- Updated dependencies [c0de08f]
- Updated dependencies [c0de08f]
- Updated dependencies [c0de08f]
- Updated dependencies
- Updated dependencies [c0de08f]
  - @zucker-framework/core@1.0.2

## 1.0.1

### Patch Changes

- Declare cache/event peers required where the public entry imports their runtime
  tokens unconditionally. This fixes missing modules when consumers install auth,
  crud or rule-engine without the rest of the monorepo. Refresh the CLI scaffold
  catalog so newly generated server projects include the required cache package.
  Refresh credit's packed development dependency metadata for the new CRUD version
  without rebuilding different metadata under an already published credit version.

## 1.0.0

### Major Changes

- First stable public release under the @zucker-framework organization. Publish compiled JavaScript, public type declarations, required runtime assets and Apache-2.0 license materials without source maps.

### Patch Changes

- Add Apache-2.0 license files, framework attribution, bundled third-party notices,
  and public npm publishing metadata to every library. Validate these materials
  in package contents before upload and declare required and optional runtime dependencies.
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @zucker-framework/core@1.0.0
