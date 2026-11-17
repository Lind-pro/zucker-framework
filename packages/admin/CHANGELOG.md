# @zucker-framework/admin

## 1.0.24

### Patch Changes

- @zucker-framework/ai@1.0.24
  - @zucker-framework/auth@1.0.24
  - @zucker-framework/common@1.0.24
  - @zucker-framework/config@1.0.24
  - @zucker-framework/core@1.0.24
  - @zucker-framework/credit@1.0.24
  - @zucker-framework/crud@1.0.24
  - @zucker-framework/dictionary@1.0.24
  - @zucker-framework/fe-types@1.0.24
  - @zucker-framework/form@1.0.24
  - @zucker-framework/logging@1.0.24
  - @zucker-framework/notification@1.0.24

## 1.0.23

### Patch Changes

- e7c1b6e: Harden account revocation, transactional credential changes, payment-history replay,
  AI task recovery, cache sequence ordering, dynamic transaction reads, browser session
  isolation, CLI execution and streamed output cleanup after the 1.0.18–1.0.21 review.

  Admin user policies may run in the mutation transaction through `userChanging` and
  `userRolesChanging` (including validated role expiries). Consumers retain policy names
  and must use the supplied transaction and a consistent lock order. Credential hooks
  must migrate from post-commit-only `sensitiveFieldsChanged` to
  `sensitiveFieldsChanging(change, tx)`; required revocation writes commit atomically.

  Direct permission replacement removes legacy untyped links by their stored IDs,
  so consumers with a required grant-type field do not receive an invalid null filter.
  Other grant types remain outside that replacement.

  Custom authentication caches must support atomic sequence advancement/reads. Redis
  sequence values are returned as decimal strings before safe-integer validation to
  avoid RESP integer rounding at the JavaScript boundary.

  AI task consumers must apply the supplied expand-only execution-checkpoint migration
  and coordinate worker cutover. Unknown prior submissions are not automatically sent
  again. Payment history must be retained with the ledger; automatic refunds fail closed
  when the historical application evidence needed to restore entitlements is absent.

  These patch-version contract changes require consumer migration and verification;
  source-level tests do not replace installation of the final immutable release.

- Updated dependencies [e7c1b6e]
  - @zucker-framework/ai@1.0.23
  - @zucker-framework/auth@1.0.23
  - @zucker-framework/crud@1.0.23
  - @zucker-framework/config@1.0.23
  - @zucker-framework/credit@1.0.23
  - @zucker-framework/dictionary@1.0.23
  - @zucker-framework/form@1.0.23
  - @zucker-framework/common@1.0.23
  - @zucker-framework/core@1.0.23
  - @zucker-framework/fe-types@1.0.23
  - @zucker-framework/logging@1.0.23
  - @zucker-framework/notification@1.0.23

## 1.0.22

### Patch Changes

- @zucker-framework/ai@1.0.22
  - @zucker-framework/auth@1.0.22
  - @zucker-framework/common@1.0.22
  - @zucker-framework/config@1.0.22
  - @zucker-framework/core@1.0.22
  - @zucker-framework/credit@1.0.22
  - @zucker-framework/crud@1.0.22
  - @zucker-framework/dictionary@1.0.22
  - @zucker-framework/fe-types@1.0.22
  - @zucker-framework/form@1.0.22
  - @zucker-framework/logging@1.0.22
  - @zucker-framework/notification@1.0.22

## 1.0.21

### Patch Changes

- 305f24b: Back office server hosts (1.0.21). All changes are additive for existing consumers.

  - back-office (new package; needs an initial maintainer publication and its own npm trusted-publisher
    binding before automatic publication): server half of the back office, composed by version.
    Subpaths `/accounts` (`/authorize/*` accounts, sessions, two-factor, OAuth, API keys, deletion,
    avatar, rate limits, bootstrap utilities), `/subscriptions` (plans, entitlements, user
    subscriptions, quota stores, per-resource charges, plan payment write-back and full-refund
    revocation), `/billing` (orders, provider webhooks, subscriptions, refunds incl. plan orders,
    plans-only mode, order recovery), `/management` (management read models and log lists), `/mail`
    (transports, SMTP presets, template catalog, transactional and account mail) and `/settings`
    (encrypted connection settings, hot apply, environment-pinned fields, policies). Model and table
    names, field maps and every optional feature are options.
  - auth (**security behaviour change**): refresh-token reuse detection. Presenting an already rotated
    refresh token revokes its persistent session (`PersistentSessionRefreshTokenStore.reused`), killing the
    successor refresh token and the session's access tokens; a reuse within 10 s of the last rotation is
    only rejected (lost-response retries), and losing a concurrent rotation is not treated as reuse.
    `RefreshTokenOptions.reuseDetection: false` restores the previous behaviour. Rotation now also stamps
    the session's `lastActiveAt`.
  - auth: `UserService.addUser(data, { passwordless, transaction })` creates accounts without a password
    credential and inside a caller-owned transaction; the created-user event is published after commit.
  - payment: `SubscriptionAssignmentService.revokePayment({ userId, reference })` revokes or shortens the
    term a fully refunded payment defined.
  - admin: one log list contract (`parseLogRecordsQuery`, `listLogRecords`, `projectLogRecord`) shared by
    the log controller factories, the back-office management host and fe-admin; `USER_FILTER` accepts
    an exact `typeId`.
  - fe-admin: `plans.presets`, `users.typeOptions`, `users.passwordReset`, users status/type filters,
    `session.reloadOnFocus`, `login.forgotPasswordHref`, `UserPicker` (searchable account picker, used by
    subscription assignment), environment-pinned connection fields shown read-only, parameterized
    `extraPages` paths.
  - back-office/subscriptions: plan assignments take a shared plan lock and plan deletes an exclusive one
    (`locks.plan`, default PostgreSQL advisory locks), so a delete cannot orphan a term without a database
    foreign key. back-office/billing: plans-only mode (`credits: null`) requires `lockAccount`.
    back-office/mail: the verification-code template is a default built-in while the account mailer is on;
    code mail failures are 503.
  - storage: `WEBDAV_STORAGE_CONNECTION_DESCRIPTOR` and `webDavOptionsFromConnection`.
  - common: `TransformInterceptor` passes raw responses through unchanged (`StreamableFile`, `@Sse()`,
    new `@RawResponse()`, a declared or already set non-JSON `Content-Type` such as Prometheus metrics).
  - cli: `zucker add back-office`; the bundled server template now composes `@zucker-framework/back-office`.

- Updated dependencies [305f24b]
  - @zucker-framework/auth@1.0.21
  - @zucker-framework/common@1.0.21
  - @zucker-framework/ai@1.0.21
  - @zucker-framework/config@1.0.21
  - @zucker-framework/core@1.0.21
  - @zucker-framework/credit@1.0.21
  - @zucker-framework/crud@1.0.21
  - @zucker-framework/dictionary@1.0.21
  - @zucker-framework/fe-types@1.0.21
  - @zucker-framework/form@1.0.21
  - @zucker-framework/logging@1.0.21
  - @zucker-framework/notification@1.0.21

## 1.0.20

### Patch Changes

- f21f444: Account growth and security (phase 3): two-factor sign-in, role expiry, OAuth popups, promotions,
  streamed S3 uploads and the back-office pieces for them.

  **BREAKING (D19) — auth:** `@Permissions(['a', 'b'])` (an array) now throws a `TypeError` when the
  class is loaded; write `@Permissions('a', 'b')`. The array form was never enforced correctly: it
  stored `[['a','b']]` and every request failed the permission check. Same for
  `@Authorize({ permissions })` with nested arrays, blank or non-string codes. `@Permissions()` (any
  signed-in user) is unchanged. Consumers must grep for `@Permissions([` before upgrading.

  - auth: TOTP helpers (`generateTotpSecret`, `totpProvisioningUri`, recovery codes and hashing) and
    `TotpValidator.verifyOnce(userId, code, secret?)`. Verification is serialised per user, so concurrent
    submissions of one code accept it once and concurrent wrong guesses cannot all pass the lockout
    check; `TwoFactorStateStore.advanceCounter` (optional) is an atomic compare-and-set of the last used
    step for shared stores; `isLockedOut` / `recordFailedAttempt` let other factors (recovery codes)
    share the lockout. Opt-in role expiry: `ZuckerAuthModule.forRoot({ roleAssignments: { expiry: true } })`
    (requires `userRoles.expiresAt`); expired links grant nothing to permissions, role dimension, menus
    and hierarchy, and the permission cache never outlives the earliest expiry.
  - admin: `GET/PUT /users/:id/roles` carry per-role `expiries` when role expiry is on (400 otherwise).
  - fe-admin: two-factor step on the login page (`AdminTwoFactorRequiredError`, `loginTwoFactor`), role
    expiry dates in the role dialog, an optional "Reset 2FA" action (`users.twoFactorResetPath`), and the
    order ledger shows the amount charged, the discount and the list price.
  - fe-auth: `openOAuthPopup` / `claimOAuthPopup` (BroadcastChannel; `blocked` falls back to redirect).
  - fe-types: `PublicBillingCheckoutPolicy.promoCodes: 'none' | 'alias'`, `UserRoleExpiries`,
    `UserRolesResponse.expiries`.
  - payment: server-frozen promotions on hosted checkout (`HostedCheckoutOffer.promotion`,
    `checkoutPayable`, `snapshotPromotion`; provider subtotal, discount and reference are verified, and
    a discount on an order without a promotion fails). Codes that bring the total to zero are refused;
    subscriptions are discounted on the first invoice only (`initialMoney`). Stripe applies each
    promotion as a per-session, single-use, `once` coupon with the server-computed fixed `amount_off`
    (never a percentage), so Stripe's total always equals the frozen payable; the frozen provider code
    travels in session metadata (`zucker_promotion_code`, now a reserved metadata key) and is reported
    back as the discount reference. Without the `coupons` API on the client, promotions are refused.
    Stripe sessions with an empty `discounts` list report the reference as unknown (amounts are still
    verified). PayPal and Creem refuse promotions.
  - storage: `S3FileManager.uploadStream` uploads in multipart parts (`partSize`, default 8 MiB,
    5 MiB–5 GiB, one part in memory, aborted on failure) instead of buffering the whole object.

  Server, web and admin templates (copied by `zucker create`, not versioned): two-factor sign-in and
  setup with a local QR code, magic links (off by default), account deletion with a 7-day grace period
  and per-feature erase contributors, staff 2FA reset, in-app notifications, feedback, promotions,
  referrals (off by default), operations insights, streamed private-file downloads with an orphan
  sweeper, and a test-only fake payment provider (`BILLING_TEST_FAKE_PROVIDER`, refused in
  production). Migrations `20261111010000`…`20261111090000` are additive; the last adds indexes with
  plain `CREATE INDEX` (run during a quiet period on large tables). The Prisma schema now declares the
  billing refund relations and index names that the migrations already created, so
  `prisma migrate diff` is empty for the whole database.

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

- Updated dependencies [f21f444]
- Updated dependencies [a8ca9ef]
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies [5280170]
- Updated dependencies [1696a82]
  - @zucker-framework/auth@1.0.20
  - @zucker-framework/fe-types@1.0.20
  - @zucker-framework/ai@1.0.20
  - @zucker-framework/credit@1.0.20
  - @zucker-framework/dictionary@1.0.20
  - @zucker-framework/form@1.0.20
  - @zucker-framework/notification@1.0.20
  - @zucker-framework/logging@1.0.20
  - @zucker-framework/common@1.0.20
  - @zucker-framework/crud@1.0.20
  - @zucker-framework/config@1.0.20
  - @zucker-framework/core@1.0.20

## 1.0.19

### Patch Changes

- Updated dependencies
  - @zucker-framework/ai@1.0.19
  - @zucker-framework/auth@1.0.19
  - @zucker-framework/common@1.0.19
  - @zucker-framework/config@1.0.19
  - @zucker-framework/core@1.0.19
  - @zucker-framework/credit@1.0.19
  - @zucker-framework/crud@1.0.19
  - @zucker-framework/dictionary@1.0.19
  - @zucker-framework/fe-types@1.0.19
  - @zucker-framework/form@1.0.19
  - @zucker-framework/logging@1.0.19
  - @zucker-framework/notification@1.0.19

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
  - @zucker-framework/common@1.0.18
  - @zucker-framework/credit@1.0.18
  - @zucker-framework/fe-types@1.0.18
  - @zucker-framework/ai@1.0.18
  - @zucker-framework/auth@1.0.18
  - @zucker-framework/config@1.0.18
  - @zucker-framework/core@1.0.18
  - @zucker-framework/crud@1.0.18
  - @zucker-framework/dictionary@1.0.18
  - @zucker-framework/form@1.0.18
  - @zucker-framework/logging@1.0.18
  - @zucker-framework/notification@1.0.18

## 1.0.17

### Patch Changes

- @zucker-framework/ai@1.0.17
  - @zucker-framework/auth@1.0.17
  - @zucker-framework/common@1.0.17
  - @zucker-framework/config@1.0.17
  - @zucker-framework/core@1.0.17
  - @zucker-framework/credit@1.0.17
  - @zucker-framework/crud@1.0.17
  - @zucker-framework/dictionary@1.0.17
  - @zucker-framework/form@1.0.17
  - @zucker-framework/logging@1.0.17
  - @zucker-framework/notification@1.0.17

## 1.0.16

### Patch Changes

- @zucker-framework/ai@1.0.16
  - @zucker-framework/auth@1.0.16
  - @zucker-framework/common@1.0.16
  - @zucker-framework/config@1.0.16
  - @zucker-framework/core@1.0.16
  - @zucker-framework/credit@1.0.16
  - @zucker-framework/crud@1.0.16
  - @zucker-framework/dictionary@1.0.16
  - @zucker-framework/form@1.0.16
  - @zucker-framework/logging@1.0.16
  - @zucker-framework/notification@1.0.16

## 1.0.15

### Patch Changes

- Updated dependencies
  - @zucker-framework/notification@1.0.15
  - @zucker-framework/ai@1.0.15
  - @zucker-framework/auth@1.0.15
  - @zucker-framework/common@1.0.15
  - @zucker-framework/config@1.0.15
  - @zucker-framework/core@1.0.15
  - @zucker-framework/credit@1.0.15
  - @zucker-framework/crud@1.0.15
  - @zucker-framework/dictionary@1.0.15
  - @zucker-framework/form@1.0.15
  - @zucker-framework/logging@1.0.15

## 1.0.14

### Patch Changes

- Updated dependencies
  - @zucker-framework/ai@1.0.14
  - @zucker-framework/auth@1.0.14
  - @zucker-framework/common@1.0.14
  - @zucker-framework/config@1.0.14
  - @zucker-framework/core@1.0.14
  - @zucker-framework/credit@1.0.14
  - @zucker-framework/crud@1.0.14
  - @zucker-framework/dictionary@1.0.14
  - @zucker-framework/form@1.0.14
  - @zucker-framework/logging@1.0.14
  - @zucker-framework/notification@1.0.14

## 1.0.13

### Patch Changes

- @zucker-framework/ai@1.0.13
  - @zucker-framework/auth@1.0.13
  - @zucker-framework/common@1.0.13
  - @zucker-framework/config@1.0.13
  - @zucker-framework/core@1.0.13
  - @zucker-framework/credit@1.0.13
  - @zucker-framework/crud@1.0.13
  - @zucker-framework/dictionary@1.0.13
  - @zucker-framework/form@1.0.13
  - @zucker-framework/logging@1.0.13
  - @zucker-framework/notification@1.0.13

## 1.0.12

### Patch Changes

- @zucker-framework/ai@1.0.12
  - @zucker-framework/auth@1.0.12
  - @zucker-framework/common@1.0.12
  - @zucker-framework/config@1.0.12
  - @zucker-framework/core@1.0.12
  - @zucker-framework/credit@1.0.12
  - @zucker-framework/crud@1.0.12
  - @zucker-framework/dictionary@1.0.12
  - @zucker-framework/form@1.0.12
  - @zucker-framework/logging@1.0.12
  - @zucker-framework/notification@1.0.12

## 1.0.11

### Patch Changes

- Updated dependencies
  - @zucker-framework/ai@1.0.11
  - @zucker-framework/auth@1.0.11
  - @zucker-framework/common@1.0.11
  - @zucker-framework/config@1.0.11
  - @zucker-framework/core@1.0.11
  - @zucker-framework/credit@1.0.11
  - @zucker-framework/crud@1.0.11
  - @zucker-framework/dictionary@1.0.11
  - @zucker-framework/form@1.0.11
  - @zucker-framework/logging@1.0.11
  - @zucker-framework/notification@1.0.11

## 1.0.10

### Patch Changes

- Connect the default form manager's create and edit actions to persistent form definitions. Supply
  missing identity/empty fields on creation, expose the permission-protected PUT route, reject invalid
  field shapes and map missing/unique records without treating failed writes as success.
- Create and update a role's metadata and permission links in one transaction. Lock the role parent
  before replacement or deletion, including empty permission sets, and evaluate sensitive changes
  against the state read after that lock. Failed link writes now roll back metadata and new roles;
  concurrent full replacements no longer combine grants.
- Require explicit read and mutation permissions on default administrative controllers instead of allowing every authenticated account. Separate user/role authorization from ordinary edits, reject nested role relation writes and privileged role changes without authorization, invalidate permission caches after binding changes, and prevent notification creation from overwriting an existing template without update permission. Public health and configurable controller factories retain their existing contracts. Existing delegated admin roles must be assigned the appropriate resource actions explicitly.
- Restore the default dictionary manager's persistent creation, item filtering and editing. Map
  public item aliases to the existing text/ordinal/describe storage contract, preserve compatible
  service inputs/outputs, and add permission-protected dictionary/item PUT endpoints with explicit
  validation, not-found and conflict responses.
- Route public package-root imports and requires to the existing matching ESM/CJS runtime and type artifacts. Previously, native ESM imports of these packages fell back to their CommonJS main entry, mixing auth/core provider classes with an application's ESM instances and breaking Nest dependency injection. Keep package.json metadata readable and preserve the existing main/module artifacts.

  Add a native Node regression for both module formats that checks package resolution, shared auth/guard identity and an Admin/Nest composition using a synthetic memory adapter. This does not make mixed import/require copies of a dual package interchangeable and does not replace persistent consumer validation. No service implementation, guard registration or access policy is relaxed.

  Use the CommonJS default export for eventemitter2 in config, dictionary and logging, with an explicit injection token referencing the original constructor. This fixes native ESM loading while retaining the shared Nest event emitter; no dependency is bundled or duplicated.

- Accept only permission-definition metadata in the create/update HTTP endpoints. Keep memberships
  behind their dedicated authorization operations, reject unsupported fields before persistence, and
  preserve the permission identifier during metadata edits.
- Validate user-role replacement input and serialize replacements through the owning user row before
  deleting and inserting memberships. Concurrent replacements must not accidentally combine grants,
  and failed writes retain the previous set. The Admin template exposes the existing assignment API
  through an authorized, localized editor with isolated drafts and retryable failures.
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @zucker-framework/dictionary@1.0.10
  - @zucker-framework/credit@1.0.10
  - @zucker-framework/notification@1.0.10
  - @zucker-framework/logging@1.0.10
  - @zucker-framework/config@1.0.10
  - @zucker-framework/form@1.0.10
  - @zucker-framework/auth@1.0.10
  - @zucker-framework/common@1.0.10
  - @zucker-framework/crud@1.0.10
  - @zucker-framework/ai@1.0.10
  - @zucker-framework/core@1.0.10

## 1.0.8

### Patch Changes

- Updated dependencies
  - @zucker-framework/ai@1.0.8
  - @zucker-framework/auth@1.0.8
  - @zucker-framework/common@1.0.8
  - @zucker-framework/config@1.0.8
  - @zucker-framework/core@1.0.8
  - @zucker-framework/credit@1.0.8
  - @zucker-framework/crud@1.0.8
  - @zucker-framework/dictionary@1.0.8
  - @zucker-framework/form@1.0.8
  - @zucker-framework/logging@1.0.8
  - @zucker-framework/notification@1.0.8

## 1.0.7

### Patch Changes

- @zucker-framework/ai@1.0.7
  - @zucker-framework/auth@1.0.7
  - @zucker-framework/common@1.0.7
  - @zucker-framework/config@1.0.7
  - @zucker-framework/core@1.0.7
  - @zucker-framework/credit@1.0.7
  - @zucker-framework/crud@1.0.7
  - @zucker-framework/dictionary@1.0.7
  - @zucker-framework/form@1.0.7
  - @zucker-framework/logging@1.0.7
  - @zucker-framework/notification@1.0.7

## 1.0.6

### Patch Changes

- Updated dependencies
  - @zucker-framework/auth@1.0.6
  - @zucker-framework/ai@1.0.6
  - @zucker-framework/common@1.0.6
  - @zucker-framework/config@1.0.6
  - @zucker-framework/core@1.0.6
  - @zucker-framework/credit@1.0.6
  - @zucker-framework/crud@1.0.6
  - @zucker-framework/dictionary@1.0.6
  - @zucker-framework/form@1.0.6
  - @zucker-framework/logging@1.0.6
  - @zucker-framework/notification@1.0.6

## 1.0.5

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @zucker-framework/ai@1.0.5
  - @zucker-framework/auth@1.0.5
  - @zucker-framework/credit@1.0.5
  - @zucker-framework/core@1.0.5
  - @zucker-framework/common@1.0.5
  - @zucker-framework/logging@1.0.5
  - @zucker-framework/notification@1.0.5
  - @zucker-framework/config@1.0.5
  - @zucker-framework/crud@1.0.5
  - @zucker-framework/dictionary@1.0.5
  - @zucker-framework/form@1.0.5

## 1.0.3

### Patch Changes

- Adopt @zucker-framework/ai@1.0.3 so generated administrative controllers and consumer providers use the same AIModelCatalogService injection token. No route contract changes.

## 1.0.2

### Patch Changes

- c0de08f: Add persistent AI model administration with encrypted/masked credentials, transactional default reassignment and host validation/cache hooks. Add constrained catalog controller factories and nested prompt rendering. Add a shared Nest/Winston system-log sink with database draining and configurable PostgreSQL operational metrics. Product fields, permissions, privacy, recipients, templates and infrastructure settings remain consumer configuration.
- c0de08f: Expose configurable access and operation log management controllers backed by the shared persistent logging services. Hosts select routes, permission resources and audit labels while reusing pagination, statistics, timelines, bounded deletion and retention endpoints.

  Add read-only record controllers with allowlisted equality filters compatible with the frontend query encoding, and shared log query/CSV controllers. Export an RFC 5987 attachment-header formatter with an escaped ASCII fallback.

- c0de08f: Add root-configured mail delivery and a database-backed localized template catalog. Reuse existing template parsing, provider adapters and host database connections. Preserve provider-native idempotency, cancellation, queue rate slots, final delivery history, locale fallback and host-owned template/preview/tracking policies. Extend email providers with complete envelopes and provider receipts; encode binary Resend attachments correctly. Add configurable template-management controllers with separate read/write permissions.

  Move mail history, atomic PostgreSQL engagement statistics, Svix callback verification and single-worker campaign orchestration into shared services. Await interrupted-campaign recovery before registering the worker, preserve atomic claims, and mark queue-add failures explicitly. Batch delivery retains bounded concurrency/deduplication and daily-quota stopping. Host callbacks own audience and suppression policies.

- Align all public Framework packages to the maintainer-selected 1.0.2 release and keep subsequent releases synchronized through a Changesets fixed group. Package dependencies and the CLI scaffold catalog follow the same version.

  This release consolidates the pending API migrations, including breaking auth and payment persistence contracts. Review docs/package-release-1.0.2.md before upgrading from 1.0.0 or 1.0.1.

- Updated dependencies [c0de08f]
- Updated dependencies [c0de08f]
- Updated dependencies [c0de08f]
- Updated dependencies [3a5d2e2]
- Updated dependencies [c0de08f]
- Updated dependencies [c0de08f]
- Updated dependencies [c0de08f]
- Updated dependencies [c0de08f]
- Updated dependencies [c0de08f]
- Updated dependencies [740f109]
- Updated dependencies [c0de08f]
- Updated dependencies [c0de08f]
- Updated dependencies [c0de08f]
- Updated dependencies [c0de08f]
- Updated dependencies [c0de08f]
- Updated dependencies [c0de08f]
- Updated dependencies [c0de08f]
- Updated dependencies [c0de08f]
- Updated dependencies [c0de08f]
- Updated dependencies [c0de08f]
- Updated dependencies [c0de08f]
- Updated dependencies [c0de08f]
- Updated dependencies
- Updated dependencies [c0de08f]
  - @zucker-framework/ai@1.0.2
  - @zucker-framework/credit@1.0.2
  - @zucker-framework/common@1.0.2
  - @zucker-framework/core@1.0.2
  - @zucker-framework/auth@1.0.2
  - @zucker-framework/notification@1.0.2
  - @zucker-framework/crud@1.0.2
  - @zucker-framework/logging@1.0.2
  - @zucker-framework/config@1.0.2
  - @zucker-framework/dictionary@1.0.2
  - @zucker-framework/form@1.0.2

## 1.0.1

### Patch Changes

- Updated dependencies
  - @zucker-framework/crud@1.0.1
  - @zucker-framework/credit@1.0.1
  - @zucker-framework/auth@1.0.1
  - @zucker-framework/config@1.0.1
  - @zucker-framework/dictionary@1.0.1
  - @zucker-framework/form@1.0.1

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
- Updated dependencies
  - @zucker-framework/auth@1.0.0
  - @zucker-framework/config@1.0.0
  - @zucker-framework/core@1.0.0
  - @zucker-framework/credit@1.0.0
  - @zucker-framework/crud@1.0.0
  - @zucker-framework/dictionary@1.0.0
  - @zucker-framework/form@1.0.0
  - @zucker-framework/logging@1.0.0
  - @zucker-framework/notification@1.0.0
