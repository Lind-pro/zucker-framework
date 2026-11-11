# @zucker-framework/auth

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

- @zucker-framework/cache@1.0.21
  - @zucker-framework/core@1.0.21
  - @zucker-framework/crud@1.0.21

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

  **Re-review follow-ups (auth / tenant / rate-limiter / fe-http-client)**
  - auth: with a cache configured, session inactivity is decided from a shared record (`token:active:<sha256>`, refreshed by `touch()` at most every `min(30 s, maxInactiveInterval/4)`), so a session used on another instance is no longer blacklisted by the instance that handled the login. Inactivity also survives restarts. New claim `zsess` (added by the framework login, or via `TokenService.issueClaims(userId)`): such tokens are rejected as `inactive` when their shared record is missing; disable with `enforceSessionInactivity: false`. `maxActiveSessions` / `OFFLINE_OTHER` use a shared per-user index (best effort, no lock).
  - auth: blacklist keys are `token:blacklist:<sha256 hex>` (raw-token keys written by 1.0.19 and earlier are still read). `revokeUserTokens` returns the watermark; tokens carrying `rva` equal to the current watermark (framework login, `rotateToken`, `issueClaims`) are accepted even when issued in the revocation second.
  - auth: `forRootAsync({ cacheProvider })` (top level) registers `TOKEN_CACHE` with `useExisting`; an options-level `cacheProvider` is resolved at `onApplicationBootstrap` and startup fails if it does not resolve (it was read with `ModuleRef.get` at factory time, which depended on import order).
  - auth: OAuth first login stores the provider email on the user only when `emailVerified === true` (the address stays on the binding row); a concurrent unique-email violation maps to `THIRD_PARTY_EMAIL_IN_USE` (409).
  - auth: `TotpValidator` accepts `stateStore` (e.g. an `ICache`) so the replay guard and validations are shared between instances. `DataPermissionGuard` warns once per route when `@DataPermission` is present but the authentication carries no permissions.
  - tenant: a global `TenantGuard` no longer rejects `@TenantAware` routes whose tenant depends on `request.user` (`jwt` strategy or `verifyTenant`) before a controller-level auth guard ran: it defers, and `TenantInterceptor` (after all guards) returns 403 when no tenant resolves. The guard builds its resolver lazily.
  - rate-limiter: `RateLimitGuard` logs once and allows the request when `@RateLimit` names a limiter that is not configured (it returned 404 for every request, e.g. on `/authorize/login`).
  - fe-http-client: in a browser, `isTrustedUrl` resolves URLs against `location.href` (`/\evil.example` is another origin); without a location only unambiguous relative paths are trusted. A refresh-token rotation is kept when the access token changed during the refresh but the session's refresh token did not.

  **BREAKING / behaviour changes (auth, re-review)** — previously listed only in the body or not at all:
  - `UserService.update` / `changePassword` / `changeState` / `deleteUser` revoke the user's tokens, including the caller's own access token when it is the same user. Migration: re-login (framework login tokens carry `rva`, so the same-second re-login works); products signing their own tokens embed `await tokenService.issueClaims(userId)`.
  - `JwtStrategyBase` pins HS256 for product subclasses; payloads with a numeric `sub`, or a `purpose` / `typ` / `token_type` / `tokenType` other than `access`, are rejected. Migration: sign access tokens with HS256 and a string `sub`; use `typ: 'access'` or no type claim.
  - The default login requires an injected `JwtService` (it no longer falls back to the user id as token).
  - With a cache, framework login tokens (`zsess`) are rejected after `maxInactiveInterval` (2 h for the default login) of inactivity on all instances, and right after an upgrade for sessions created before it (no shared record). Migration: users sign in again once; set `enforceSessionInactivity: false` to keep the JWT lifetime as the only limit.
  - Blacklist cache keys changed format (see above); `revokeUserTokens` now returns `Promise<number>`.
  - rate-limiter: `#userId` / `#username` bucket keys changed (`user:` / `username:`); counters start fresh.
  - tenant: see the guard ordering change above (the guard no longer returns 403 itself in that case; the interceptor does).

- 1696a82: Platform hardening (phase 4): every connection profile applies without a restart, payment credentials
  are kept per revision, and generated projects ship assistant skills. All changes are additive.

  - config: new subpath `@zucker-framework/config/connections` with the connection-profile machinery
    (`defineConnectionProfile`, `composeConnectionProfiles`, field validation, the
    endpoint-follows-secret rule), `ConnectionProfileStore` (advisory lock, revision compare-and-swap,
    same-transaction audit callback, encrypted revision archive in `connection_profile_revisions`,
    `deleteRevisions` that never deletes the current revision), `ConnectionRuntime` (`environment`,
    `liveEnvironment`, `environmentAt`, `revisions`, `currentRevision`) and `RuntimeProviderSlot`
    (`ttl` or `strict` freshness, leased instances disposed after their last user, a failed build keeps
    the previous instance). The package root export is unchanged.
  - payment: `HostedCheckoutOptions.providers` also accepts a resolver (`ids`, `current`, `forOrder`,
    `webhookCandidates`, at most 8 candidates, own account only); the service captures one adapter per
    operation, and a verified webhook can never settle an order of another account scope. The existing
    array form behaves as before. `staticHostedCheckoutProviders` is exported. Orders may carry a
    `configRevision`.
  - auth, notification, storage, ai, payment: plain-data connection descriptors
    (`connection-descriptor.ts`, one export each) with stable ids, environment keys and label keys; no
    new dependency.
  - cli: project-template bundles carry an optional `skills` field; `create` and `init` install the
    bundled skills (brand quick-start, page builder, feature builder, provider setup, deploy checklist)
    into `.agents/skills` with `.claude/skills` links, never overwriting, never following links out of the
    project, and only warning when a directory is unwritable. New exports `installConsumerAgentSkills`,
    `validateConsumerSkills` and `CONSUMER_SKILL_LIMITS` in `@zucker-framework/cli/agent-instructions`.
  - fe-admin: the Connections page shows per-profile apply errors (`applyError`), the retained revision
    count and the payment hot-apply notice, and asks for confirmation before a private-storage location
    change (409 `DATA_LOCATION_CHANGE_UNACKNOWLEDGED`), resending with `acknowledgeDataLocationChange`.

  Templates (not published packages): payment, sign-in, mail, delivery, storage and AI profiles are
  `applyMode: 'hot'`. New payment orders record `payment-<id>@<revision>` and use the current revision;
  existing orders, subscriptions and refunds use the newest retained revision of their own account (D12).
  Superseded payment revisions are purged only by an operator, older than
  `CONNECTION_REVISION_RETENTION_DAYS` (default and minimum 400; D13). A storage location change while files
  exist needs explicit acknowledgement (D14). New migration `20261112010000_connection_revisions` (it
  archives the current revision of each saved profile at start-up). New server script `content:check`.
  Dockerfiles accept an optional `NPM_REGISTRY` build argument (default unchanged).

  Generated workspace fixes found by the packed-artefact launch acceptance (`pnpm acceptance:launch`):
  - The compose stack could not start: MinIO no longer publishes pullable community images, and production
    refused the internal `http://minio:9000` endpoint. Storage is now SeaweedFS (`chrislusf/seaweedfs:4.01`,
    service still named `minio`, same `MINIO_*`/`FILES_S3_*` keys, app account limited to its bucket), and
    `FILES_S3_INTERNAL_HTTP=true` (environment only) allows plain http to a single-label private host.
  - CMS publish revalidation now reaches Web inside compose (`REVALIDATE_URL=http://web:3000`, and the web
    container receives `REVALIDATE_SECRET`); before, published pages stayed stale for the cache lifetime.
  - `pnpm setup:admin` seeds two example plans and one example credit pack (not purchasable until a
    provider price is added) when `BILLING_CATALOG_JSON` has no offers.

- Updated dependencies
- Updated dependencies
- Updated dependencies [5280170]
  - @zucker-framework/cache@1.0.20
  - @zucker-framework/crud@1.0.20
  - @zucker-framework/core@1.0.20

## 1.0.19

### Patch Changes

- @zucker-framework/cache@1.0.19
  - @zucker-framework/core@1.0.19
  - @zucker-framework/crud@1.0.19

## 1.0.18

### Patch Changes

- @zucker-framework/cache@1.0.18
  - @zucker-framework/core@1.0.18
  - @zucker-framework/crud@1.0.18

## 1.0.17

### Patch Changes

- @zucker-framework/cache@1.0.17
  - @zucker-framework/core@1.0.17
  - @zucker-framework/crud@1.0.17

## 1.0.16

### Patch Changes

- @zucker-framework/cache@1.0.16
  - @zucker-framework/core@1.0.16
  - @zucker-framework/crud@1.0.16

## 1.0.15

### Patch Changes

- @zucker-framework/cache@1.0.15
  - @zucker-framework/core@1.0.15
  - @zucker-framework/crud@1.0.15

## 1.0.14

### Patch Changes

- @zucker-framework/cache@1.0.14
  - @zucker-framework/core@1.0.14
  - @zucker-framework/crud@1.0.14

## 1.0.13

### Patch Changes

- @zucker-framework/cache@1.0.13
  - @zucker-framework/core@1.0.13
  - @zucker-framework/crud@1.0.13

## 1.0.12

### Patch Changes

- @zucker-framework/cache@1.0.12
  - @zucker-framework/core@1.0.12
  - @zucker-framework/crud@1.0.12

## 1.0.11

### Patch Changes

- @zucker-framework/cache@1.0.11
  - @zucker-framework/core@1.0.11
  - @zucker-framework/crud@1.0.11

## 1.0.10

### Patch Changes

- Add atomic owner-scoped renaming for active API keys, returning only safe name/id metadata while preserving secret, permissions and lifecycle state.
- Expose PersistentSessionRefreshTokenStore to bind the existing token-pair lifecycle to durable, independently revocable sessions without cache-miss resurrection. Add exact session lookup and active-session refresh initialization.

  The Server consumer template composes this API with public registration, hashed one-use verification/reset tickets, HttpOnly refresh cookies, owner-scoped sessions, credential-version invalidation and explicit administrator setup. The full template requires its own PostgreSQL migrations and mail configuration; no default administrator password is created on startup. This is local source integration, not a published artifact or a production migration.

- Add server-side Google ID-token verification with bounded JWKS caching and rotation, plus one-time OAuth login/linking proofs composed from existing ticket primitives. Reject browser-supplied third-party profiles at the generic binding endpoint: consumers must configure a verified binding-proof resolver or keep their own authenticated binding controller. Preserve the trusted low-level binding API and consumer-owned admission, ownership and transaction policies.
- Updated dependencies
  - @zucker-framework/cache@1.0.10
  - @zucker-framework/crud@1.0.10
  - @zucker-framework/core@1.0.10

## 1.0.8

### Patch Changes

- @zucker-framework/cache@1.0.8
  - @zucker-framework/core@1.0.8
  - @zucker-framework/crud@1.0.8

## 1.0.7

### Patch Changes

- @zucker-framework/cache@1.0.7
  - @zucker-framework/core@1.0.7
  - @zucker-framework/crud@1.0.7

## 1.0.6

### Patch Changes

- Require explicit related model names in UserService.deleteUser. Delete related userId records and the account on one transaction, propagating cleanup failures. Removes hard-coded optional tables and swallowed database errors; callers must supply their schema binding.
- @zucker-framework/cache@1.0.6
  - @zucker-framework/core@1.0.6
  - @zucker-framework/crud@1.0.6

## 1.0.5

### Patch Changes

- Add product-neutral refresh-pair issuer, verifier, identity-loader and atomic store ports, with a legacy string-JTI cache adapter, explicit missing-key policy, and refresh revocation tombstones. Provide an explicitly process-local lock for process-local caches without installing a persistence fallback.

  Retain TokenService revocation evidence after no-cache session removal and reject ambiguous JWT authorization headers before Passport/blacklist credential parsing can diverge. Preserve optional/local guard compatibility defaults and support explicit strict credential/error policies.

- Prevent same-password updates from persisting plaintext, preserve caller DTOs and omitted fields, and add an update-only user operation plus transactional role-binding replacement with consumer field mapping. Password encoders and account policy remain explicitly configurable.
- Updated dependencies
  - @zucker-framework/core@1.0.5
  - @zucker-framework/cache@1.0.5
  - @zucker-framework/crud@1.0.5

## 1.0.2

### Patch Changes

- c0de08f: Centralize browser-safe field redaction and UA inspection in Core public subpaths; keep existing auth and frontend exports backed by those implementations. Add an optional, explicitly configured Sentry adapter, health-check subsets that fail closed when probes are absent, and reusable mail/webhook provider probes. Reuse webhook transport with injectable fetch, redirect policy and typed delivery errors. Add the runtime-template safe link primitive.

  Applications retain routes, business queries, thresholds, field selections, SDK configuration, locale labels, external-call authorization and message content. Sources and independent tests are prepared; verification and immutable release remain pending.

- c0de08f: Add atomic owner-constrained session revocation and a typed JwtStrategyBase extension point for asynchronous product identity validation. Preserve the default JwtStrategy mapping and constructor. Consumers can configure PersistentSessionService and RefreshTokenCookie directly without local wrapper classes; session metadata, cookie names and TTL/cache policy remain application configuration.
- 740f109: Add persistent database-backed sessions with atomic refresh rotation and revocation, optional deny-only caching, and configurable HttpOnly refresh-cookie transport. Add a required ownership guard for JWT request.user consumers, reuse the existing OwnCreated handler with explicit grant fallback, and check ownership for detail reads instead of relying on collection filters.
- c0de08f: Add API-key issuance, SHA-256 lookup, atomic revocation-aware usage touch, owner-bound management and header-only authentication over the existing DatabaseAdapter. Prefixes, default scopes/quotas, model names and response messages remain explicit consumer options.

  Add atomic rate consumption with a per-subject cap to the configured limiter engine, reusing its Redis deadline and persistent memory insurance instead of per-key clients or read/write counters. Key generation returns the secret once; database and key formats require no migration. Adapter and consumer verification are required before release.

- c0de08f: **Breaking API changes in the maintainer-selected unified 1.0.2 release.** Review the migration requirements below before upgrading; the shared patch version does not imply backward compatibility for this entry.

  Add caller-transaction identity serialization, persistent verification-code and opaque one-time-ticket mechanisms, configurable OAuth binding persistence/locking, and native atomic permission imports. Permission import no longer falls back to find/create when upsert is unavailable and uses a unified synchronization success message. Configure an atomic persist callback for adapters without native upsert.

  Verification requires an available authoritative attempt store and fails closed on cache degradation. Configure a per-user transaction lock for concurrent-safe final OAuth login-method removal. Product trust, account creation, TTLs, templates and claim payloads remain consumer policy. Independent test sources are supplied but were not executed during the consumer's verification pause.

- c0de08f: Add SecretCipher for AES-256-GCM/scrypt encrypted fields with explicit key material, stable v2 encoding and opt-in read-only legacy CBC support. Require full GCM authentication tags and reject malformed/plaintext stored values. Add ScryptEncoder implementing PasswordEncoder while preserving the two-part hex salt/derived-key format. Application environment, key selection and accepted historical formats remain consumer configuration; no data rewrite or password reset is required for valid existing records.
- c0de08f: Expose API_KEY_GUARD_OPTIONS as an optional Nest injection token so guards discovered on routes receive the configured policy through imported modules.

  Route application log writes through the shared sink lifecycle. Stop accepting Winston writes before shutdown, drain accepted logs once, and preserve sanitized late shutdown diagnostics without writing to an ended stream.

- Align all public Framework packages to the maintainer-selected 1.0.2 release and keep subsequent releases synchronized through a Changesets fixed group. Package dependencies and the CLI scaffold catalog follow the same version.

  This release consolidates the pending API migrations, including breaking auth and payment persistence contracts. Review docs/package-release-1.0.2.md before upgrading from 1.0.0 or 1.0.1.

- c0de08f: Extract consumer-independent cancellation scopes, per-chunk idle timeouts, bounded concurrency admission and timezone helpers; reuse cancellation in the AI adapter. Add signed browser-bound OAuth state, login audit with transactional counters, device parsing and configurable Passport guards. Authorization guards can deny provider errors and select a safe log identity without rewriting request.user.

  Add a validated HTTP query DTO without changing QueryParamEntity. MetadataLogService reuses log persistence for explicitly projected metadata. The optional ai/langchain entry captures call timing and usage without forcing LangChain on other AI consumers.

  Add the single-process task supervisor and temporary export artifact manager. Both preserve their process-local scheduling boundaries: neither introduces durable task storage, distributed leases or multi-executor safety. Consumers retain state transitions, ownership, retry eligibility, prompts, budgets, messages, retention schedules and output policy.

  Source migration only: new APIs, independent test sources and consumers are prepared; verification and immutable publication remain separate pending stages.

  Add durable recipient inbox operations and bounded verified object transfer; retain recipient constraints in updates, reject content collisions, keep dry runs read-only and verify uploaded object bytes before success.

- Updated dependencies [c0de08f]
- Updated dependencies [c0de08f]
- Updated dependencies [c0de08f]
- Updated dependencies [c0de08f]
- Updated dependencies [c0de08f]
- Updated dependencies [c0de08f]
- Updated dependencies
- Updated dependencies [c0de08f]
  - @zucker-framework/cache@1.0.2
  - @zucker-framework/core@1.0.2
  - @zucker-framework/crud@1.0.2

## 1.0.1

### Patch Changes

- Updated dependencies
  - @zucker-framework/crud@1.0.1

## 1.0.0

### Major Changes

- First stable public release under the @zucker-framework organization. Publish compiled JavaScript, public type declarations, required runtime assets and Apache-2.0 license materials without source maps.

### Minor Changes

- Harden framework runtime packaging and public error handling, add controller and global-guard registration controls, unify the database adapter token, bound monitoring samples, expose portable metrics and uptime helpers, redact email delivery logs, and protect rate-limit storage keys.

### Patch Changes

- Add Apache-2.0 license files, framework attribution, bundled third-party notices,
  and public npm publishing metadata to every library. Validate these materials
  in package contents before upload and declare required and optional runtime dependencies.
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @zucker-framework/cache@1.0.0
  - @zucker-framework/core@1.0.0
  - @zucker-framework/crud@1.0.0
