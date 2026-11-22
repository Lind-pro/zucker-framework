# @zucker-framework/fe-auth

## 1.0.28

### Patch Changes

- @zucker-framework/fe-storage@1.0.28

## 1.0.27

### Patch Changes

- @zucker-framework/fe-storage@1.0.27

## 1.0.26

### Patch Changes

- @zucker-framework/fe-storage@1.0.26

## 1.0.25

### Patch Changes

- @zucker-framework/fe-storage@1.0.25

## 1.0.24

### Patch Changes

- @zucker-framework/fe-storage@1.0.24

## 1.0.23

### Patch Changes

- e7c1b6e: Bind HTTP retries and cookie-session restoration to the originating session. Add the
  optional HttpClientConfig.sessionKey callback and wire the admin consumer to its existing
  identity policy. Cookie clients without a stable key conservatively cancel ambiguous
  credential changes; retain request abort scopes for prompt cancellation.

  Release Observable subscriptions and tracing spans on completion, failure and cancellation.
  Dispose late network/datasource creations after lifecycle changes, roll back partially
  started rule triggers, bind provider disposables to their registration, stream local upload
  chunks with backpressure, preserve valid zero aggregations and cap all HybridCache L1 writes.

  Network shutdown now waits for pending provider operations; providers must bound their I/O.
  HybridCache L1 caps must be finite and non-negative; zero disables L1 population. Correct
  legacy test typing without changing runtime exports or weakening assertions.

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

- @zucker-framework/fe-storage@1.0.23

## 1.0.22

### Patch Changes

- aee88b9: Sign-in identifier options for the back-office account host. Defaults keep the 1.0.21 behaviour.

  - back-office/accounts: `BackOfficeAccountsModule.forRoot({ login: { identifier } })` with
    `'username'` (default, body `{username, password}`), `'email'` (`{email, password}`; trimmed,
    lower-cased address matched against the stored normalized `users.email`, an address on several rows
    signs nobody in) or `'username-or-email'` (`{login, password}`; an exact username wins). Every miss
    (unknown, malformed, ambiguous, password-less, disabled, unverified) answers the same 401 after one
    hash comparison; the `login`/`login-account` budgets key on the normalized identifier. Deletion cancel
    takes the same field and deletion confirmation also accepts the address with an e-mail identifier.
    New `AccountService.verifyLoginPassword` / `findLoginAccount`, `ACCOUNT_LOGIN_IDENTIFIER_FIELDS`,
    `AccountLoginIdentifier`; `loginAccountKey(body, identifier?)`.
  - back-office/accounts: `signup: { typeId }` (default `'member'`) for accounts created by register and
    OAuth sign-up.
  - fe-auth: `loginIdentifierInput(identifier)` and `loginRequestBody(identifier, value, password)`.
  - fe-admin: `login.identifier` selects the sign-in label, input type and request field.

- @zucker-framework/fe-storage@1.0.22

## 1.0.21

### Patch Changes

- @zucker-framework/fe-storage@1.0.21

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

- Security fixes for auth, tenant, gateway, rate-limiter and the frontend auth/HTTP packages.

  **auth**
  - `DimensionDataAccessHandler` now actually receives `DimensionService` through DI (it was always `undefined` in the bundle) and fails closed when the service is missing. Dimension-scoped data permissions are enforced again.
  - Token revocation works at request time and across processes:
    - `JwtAuthGuard` (and `OptionalJwtAuthGuard`, when `TokenService` is injectable) rejects blacklisted tokens, known sessions whose state is not `normal` (lock, offline, expired by `maxInactiveInterval`), and tokens issued at or before a per-user revocation watermark.
    - New `TokenService.checkAccessToken(token, { sub, iat })`. `signOut`, `signOutByUserId`, `changeState`/`changeUserState` with terminal states, and `revokeUserTokens` now blacklist and/or record the watermark in the configured cache, so tokens issued by other instances or before a restart are rejected. Tokens whose `iat` falls in the same second as a user revocation are also rejected.
    - `forRootAsync` now resolves `cacheProvider` (it was hard-wired to `null`). New module options: `allopatricLoginMode`, `tokenBlacklistTtlMs`, `accessTokenTtl`, `roleHierarchyCacheTtlMs`.
    - In-memory session maps are swept periodically; `rotateToken` keeps the session type and inactivity interval.
  - The default `AUTHENTICATION_MANAGER` rejects disabled users (`status` falsy), no longer returns the password hash, and compares against a dummy hash for unknown users. `UserService` revokes a user's tokens on disable, delete and password change when a `TokenService` is provided (wired automatically by `ZuckerAuthModule`; manual constructions can pass it as the 4th constructor argument or call `setTokenService`).
  - `ThirdPartyAccountService.findOrCreateUser` links an OAuth identity to an existing account by email only when `profile.emailVerified === true` and the local account's email is verified; otherwise it throws `THIRD_PARTY_EMAIL_UNVERIFIED` / `THIRD_PARTY_EMAIL_IN_USE` (409). New users get the username `<provider>_<providerAccountId>` (never the display name), `emailVerified` only from the provider's assertion, and user + binding are created in one transaction. `ThirdPartyProfile` gains `emailVerified`. `findAccount`/`bindAccount` are unchanged.
  - `exchangeGitHubOAuthCode` reports `emailVerified` whenever it fetched `/user/emails`. OAuth code exchanges have a default 10 s timeout (`timeoutMs`, 0 disables).
  - Access tokens: `JwtStrategy` pins HS256, requires `sub`, and rejects payloads with `purpose` or a non-`access` `typ`/`token_type`/`tokenType`. Framework login tokens carry `typ: 'access'` and a `jti`.
  - Login events (before/success/failed) no longer include the password; only the in-process decode event sees it.
  - `DataPermissionGuard` reads class-level `@DataPermission` and denies when a configured data-access type has no handler.
  - `TwoFactorGuard` throws 401 when unauthenticated, no longer reads the code from the query string, and scopes a successful verification to the current session (jti/sid/credential). `TotpValidator` rejects replayed codes, locks out after `maxAttempts` (default 5) failures for `lockMs` (default 15 min), and accepts a shared `attemptStore`. `TwoFactorValidatorProvider.createTwoFactorValidator` / `TwoFactorService.getValidator` take an optional `sessionId`.
  - `RoleService` built by the module is wired to `PermissionService` and `RoleHierarchyService`, so role changes invalidate caches; the hierarchy cache has a TTL (default 60 s).
  - `AuthorizationController` injects `AuthenticationHolder` by class (the string token never resolved).

  **BREAKING (auth)**
  - `resolveJwtSecret`: without `jwtSecret`/`JWT_SECRET`, startup now fails unless `NODE_ENV` is exactly `development` or `test` (previously only `production`/`staging` failed). Outside development/test the secret must be at least 32 characters. `JWT_SECRET` is now read as a fallback. Migration: set a 32+ character `jwtSecret` or `JWT_SECRET`.
  - The default login rejects users whose `status` is not truthy. Migration: make sure enabled users have `status: true`.
  - Signed-out, kicked and inactivity-expired framework sessions no longer authenticate; framework login tokens now expire after 2 h of inactivity (the `expires` value the login already returned).
  - `UserTokenController` (not registered by default) no longer returns raw tokens: responses carry `tokenId` (SHA-256, base64url) instead of `token`, and `token/:tokenId`, `:tokenId/touch` routes take that id. `user/total` and `token/total` are reachable and require query permission; `reset` signs out the caller's own token; `PUT user/:userId/:state` accepts the lower-case state values and returns 400 on invalid input.
  - `TwoFactorGuard` ignores `?verifyCode=` query parameters. Migration: send the code in the body or the `x-verify-code` header.
  - `ThirdPartyAccountService.findOrCreateUser` no longer links by unverified email and no longer uses `displayName` as the username. Migration: pass `emailVerified: true` only for provider-verified addresses.

  **tenant**
  - **BREAKING:** the default strategy is now `jwt` (tenant from `request.user`). `header`/`subdomain` require `verifyTenant(tenantId, request)` or an explicit `trustClientTenant: true`; a failed verification returns 403. Migration: configure one of those when relying on `X-Tenant-ID`.
  - **BREAKING:** `RowLevelIsolation` throws `TenantContextRequiredError` without a tenant context. Migration: wrap system/job code in `TenantContext.runWithoutTenantIsolation()` or pass `{ allowMissingTenant: true }`.
  - Tenant IDs must match `/^[A-Za-z0-9_-]{1,64}$/` (configurable `tenantIdPattern`); malformed, array or comma-joined values return 400. `SchemaLevelIsolation.getSchemaName()` rejects invalid IDs.
  - `TenantGuard` resolves the tenant itself (it previously ran before the interceptor and always failed); `forRootAsync` honours `enableGuard`; the interceptor unsubscribes on client disconnect.

  **gateway**
  - A late close of a replaced session no longer removes the live session or marks the device offline; messages whose decoded `thingId` differs from the session's are dropped (override `isAuthorizedThing` for child devices); a failed ONLINE update removes the session; `HttpDeviceGateway` connects inside its `try`.

  **rate-limiter**
  - `#userId`/`#username` keys use `user:`/`username:` buckets and fall back to a separate `anon-ip:` bucket (or 401 with `requireUser: true`) instead of silently sharing the IP bucket; user-keyed counters start fresh.
  - 429 responses carry `Retry-After`; unknown-limiter errors no longer list configured limiter names.
  - A failed initial Redis connection is retried in the background with backoff (`redis.reconnectIntervalMs`, `redis.maxReconnectIntervalMs`).
  - `windowSeconds`/`maxRequests` on `@RateLimit` are deprecated (still ignored, now warned). Dynamic-limiter glob patterns are matched linearly (no regex backtracking).

  **fe-auth / fe-http-client / fe-permission**
  - `isSafeRelativeRedirect` rejects all control characters and backslashes and requires the resolved URL to stay on the same origin (`/\t/evil.com` was accepted).
  - **BREAKING (fe-http-client):** the bearer token is attached only to `baseURL`-relative, same-origin, `baseURL`/`streamBaseURL`-origin or `trustedOrigins` requests, and 401/403 from other origins no longer refresh or clear the session. Migration: list extra API origins in `trustedOrigins`.
  - Tokens from response headers are adopted only from trusted origins, for non-aborted requests sent with the still-current token, and can be disabled or filtered with `acceptResponseToken`. A refresh that completes after sign-out stores nothing and cancels the request.
  - `proxyHttpRequest` strips hop-by-hop and client-supplied forwarding headers (set `clientIp` / `trustForwardedFor`), and drops `content-encoding`/`content-length` for decoded bodies.
  - `cookie-session` signs the tab out on `localStorage.clear()` in another tab. SSE stops after `onEvent` returns `false`, supports `reconnectOnEnd`, per-reconnect `headers` functions and a bounded buffer (`maxBufferLength`); `fetchStream` applies `timeout` together with a caller `signal`. Envelopes with a numeric non-success status and no message reject; `BaseService` encodes ids.
  - **BREAKING (fe-permission):** `PermissionGuard` no longer treats a plain `admin` permission as super-admin (only `*`/`superadmin`, matching `usePermission` and the backend).

- @zucker-framework/fe-storage@1.0.20

## 1.0.19

### Patch Changes

- @zucker-framework/fe-storage@1.0.19

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
