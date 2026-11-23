# @zucker-framework/fe-types

## 1.0.29

### Patch Changes

- @zucker-framework/core@1.0.29

## 1.0.28

### Patch Changes

- @zucker-framework/core@1.0.28

## 1.0.27

### Patch Changes

- @zucker-framework/core@1.0.27

## 1.0.26

### Patch Changes

- @zucker-framework/core@1.0.26

## 1.0.25

### Patch Changes

- @zucker-framework/core@1.0.25

## 1.0.24

### Patch Changes

- @zucker-framework/core@1.0.24

## 1.0.23

### Patch Changes

- @zucker-framework/core@1.0.23

## 1.0.22

### Patch Changes

- @zucker-framework/core@1.0.22

## 1.0.21

### Patch Changes

- @zucker-framework/core@1.0.21

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

- Updated dependencies
- Updated dependencies [5280170]
  - @zucker-framework/core@1.0.20

## 1.0.19

### Patch Changes

- @zucker-framework/core@1.0.19

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

## 1.0.2

### Patch Changes

- c0de08f: Centralize browser-safe field redaction and UA inspection in Core public subpaths; keep existing auth and frontend exports backed by those implementations. Add an optional, explicitly configured Sentry adapter, health-check subsets that fail closed when probes are absent, and reusable mail/webhook provider probes. Reuse webhook transport with injectable fetch, redirect policy and typed delivery errors. Add the runtime-template safe link primitive.

  Applications retain routes, business queries, thresholds, field selections, SDK configuration, locale labels, external-call authorization and message content. Sources and independent tests are prepared; verification and immutable release remain pending.

- c0de08f: Add reusable client CRUD, typed auth stores with consumer logout/permission hooks, best-effort browser storage, portable Mermaid sanitization/layout/rendering, and shared template placeholders.
- c0de08f: Expose browser-safe recursive redaction for explicit sensitive field lists. Consumers keep their privacy field names and error-reporter hooks; the primitive does not import Node or NestJS packages and does not mutate input data.
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
