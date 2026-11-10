# @zucker-framework/admin

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
