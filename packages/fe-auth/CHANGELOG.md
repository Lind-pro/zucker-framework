# @zucker-framework/fe-auth

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

- @zucker-framework/fe-storage@1.0.18

## 1.0.17

### Patch Changes

- Add session binding for browser clients: `jwtSessionKey(claims)` identifies a session by application-chosen JWT claims, `acceptsSessionToken` accepts token rotation only within the same session, `sessionIdentity` exposes the comparison key, and `createSessionRequestScope` aborts in-flight requests when the user or session changes while keeping them alive across token rotation. Extracted from Zucker Copyright, where admin and landing previously carried their own copy.
- @zucker-framework/fe-storage@1.0.17

## 1.0.16

### Patch Changes

- @zucker-framework/fe-storage@1.0.16

## 1.0.15

### Patch Changes

- @zucker-framework/fe-storage@1.0.15

## 1.0.14

### Patch Changes

- @zucker-framework/fe-storage@1.0.14

## 1.0.13

### Patch Changes

- @zucker-framework/fe-storage@1.0.13

## 1.0.12

### Patch Changes

- @zucker-framework/fe-storage@1.0.12

## 1.0.11

### Patch Changes

- @zucker-framework/fe-storage@1.0.11

## 1.0.10

### Patch Changes

- @zucker-framework/fe-storage@1.0.10

## 1.0.8

### Patch Changes

- @zucker-framework/fe-storage@1.0.8

## 1.0.7

### Patch Changes

- @zucker-framework/fe-storage@1.0.7

## 1.0.6

### Patch Changes

- @zucker-framework/fe-storage@1.0.6

## 1.0.5

### Patch Changes

- Updated dependencies
  - @zucker-framework/fe-storage@1.0.5

## 1.0.2

### Patch Changes

- d8b086d: Allow consumers to configure persistence versioning, hydration and field selection before initial auth-store hydration, preserving the default persistence behavior.
- c0de08f: Use a storage adapter's typed auth setters when available, preserving generic key/value adapters. Synchronize hydrated sessions with the HTTP client's token storage and retain consumer hydration callbacks. Accept typed user profiles in LocalStore without requiring an index signature.
- c0de08f: Add reusable client CRUD, typed auth stores with consumer logout/permission hooks, best-effort browser storage, portable Mermaid sanitization/layout/rendering, and shared template placeholders.
- c0de08f: Add configurable analytics headers, payload serialization and session identifiers so consumers can preserve authenticated single-event APIs while sharing keepalive delivery. Keep the default batch/beacon contract and fall back to fetch when a beacon cannot be queued.

  Export the authentication persistence hydration hook factory and local-redirect validation primitive. Product routes, locale rules, event schemas and identity/consent policies remain in consumers. These source changes require focused package and consumer validation before release.

  Export a Web Request/Response streaming proxy with explicit upstream selection and optional GET/HEAD transport retries. Preserve request cancellation, authentication headers and SSE response streaming without coupling to a consumer router or environment.

- Align all public Framework packages to the maintainer-selected 1.0.2 release and keep subsequent releases synchronized through a Changesets fixed group. Package dependencies and the CLI scaffold catalog follow the same version.

  This release consolidates the pending API migrations, including breaking auth and payment persistence contracts. Review docs/package-release-1.0.2.md before upgrading from 1.0.0 or 1.0.1.

- Updated dependencies [c0de08f]
- Updated dependencies [c0de08f]
- Updated dependencies [c0de08f]
- Updated dependencies
  - @zucker-framework/fe-storage@1.0.2

## 1.0.0

### Major Changes

- First stable public release under the @zucker-framework organization. Publish compiled JavaScript, public type declarations, required runtime assets and Apache-2.0 license materials without source maps.

### Patch Changes

- Add Apache-2.0 license files, framework attribution, bundled third-party notices,
  and public npm publishing metadata to every library. Validate these materials
  in package contents before upload and declare required and optional runtime dependencies.
- Updated dependencies
- Updated dependencies
  - @zucker-framework/fe-storage@1.0.0
