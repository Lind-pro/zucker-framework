# @zucker-framework/rate-limiter

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

- a8ca9ef: AI product layer (phase 2): metered image/video/music generation tasks, streaming chat with history,
  public site images and the back-office pages for them.

  - ai-tasks (new): `AITaskService` runs durable, credit-metered media generation on the
    `@zucker-framework/task` runtime: idempotent submit with a credit hold, short poll runs that hold no
    worker slot while the provider works, verified provider callbacks as wake-up hints, cancellation,
    deadlines, outputs streamed into private storage (own size cap, type sniffed and hashed while
    streaming; the template counts them toward the owner's file quota) and exactly-once hold
    settlement. Lock order is `async_jobs` before `ai_tasks` in every transaction. `./adapters` maps the
    credit ledger and storage onto its ports. Schema in `assets/ai-tasks.{prisma,postgresql.sql}`.
  - ai: vendor-neutral `HttpAsyncTaskMediaProvider` (JSON-declared submit/poll adapter, https only,
    host-locked, SSRF-safe fetch, HMAC callback verifier); `AIProviderCallbackVerifier` contract;
    `AudioGenerationProvider`; `MediaTaskResult.outputs`; streamed `reasoning` chunks (DeepSeek,
    Anthropic, Gemini) and an awaited `onChunk` option on `NativeAIClient.stream`. New
    `@zucker-framework/ai/testing` subpath: `FakeChatModel`, `FakeMediaProvider`,
    `FakeCallbackVerifier` (scriptable, `reset()`), for consumers' tests without paid calls.
  - fe-http-client: a refused `fetchStream` error now carries the JSON body's `code` and
    `response.data` (like axios errors), so callers can map server error codes, not only the status.
  - storage: `PublicAssetService` for content-addressed, re-encoded public images (PNG/JPEG/WebP,
    SVG rejected).
  - rate-limiter: a request is charged at most once per limiter even when `RateLimitGuard` runs twice
    (global guard plus `@UseGuards`, or class plus handler). The global guard now defers to routes that
    list `RateLimitGuard` themselves (`GlobalRateLimitGuard`). Previously such routes spent two points
    per request, so a limit of N admitted N/2.

  Server template (copied by `zucker create` / `zucker init`, not versioned): `/api/ai/catalog`,
  `/api/ai/tasks*` (Idempotency-Key, Origin check, `ai-submit` limiter), `/api/v1/ai/tasks*` for API
  keys with the new opt-in `ai:generate` scope, `/api/ai/tasks/callbacks/:provider`, `/api/chat*` with
  SSE streaming (`Cache-Control: private, no-store, no-transform`, so compressing proxies such as
  Next's do not buffer it) and per-message settlement, `/api/management/{ai-tasks,chats}` (`ai-tasks:query`,
  `chats:query`), hot-applied `ai-pricing` / `ai-catalog` policies, public assets
  (`/api/public-assets/*`, admin upload). Env: `AI_MEDIA_ADAPTERS`, `AI_TASKS_*_MAX_WAIT_MINUTES`,
  `AI_OUTPUT_MAX_BYTES`, `CHAT_MAX_OUTPUT_TOKENS`, `PUBLIC_ASSETS_MAX_BYTES`, `PUBLIC_ASSETS_BASE_URL`.
  Files above `FILES_MAX_BYTES` download through the ticket route as a stream. `AI_TEST_FAKE_PROVIDERS`
  is a test-only switch (refused in production). Run `prisma migrate deploy`: the migrations are additive (public assets, AI tasks and chat, AI
  back-office permissions and menus for already-seeded databases).

  Web template: AI studio (`/ai/image`, `/ai/video`, `/ai/music`), chat (`/chat`), console pages
  `/account/tasks` and `/account/chats`, header balance refreshes after a charge; `/ai` and `/chat` are
  session-gated and never shared-cached; per-account pages mount only after the session hydrates.
  Default navigation gains AI studio and Chat links. Admin template: AI tasks, AI chats, Models & pricing pages and
  upload buttons for site images and the logo.

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

- Updated dependencies
- Updated dependencies [5280170]
  - @zucker-framework/core@1.0.20

## 1.0.19

### Patch Changes

- @zucker-framework/core@1.0.19

## 1.0.18

### Patch Changes

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

- Updated dependencies
  - @zucker-framework/core@1.0.5

## 1.0.2

### Patch Changes

- c0de08f: Add managed cache services with bounded Redis degradation, coalesced loads, mutation fencing, configurable memory capacity and explicit single-owner lifecycle. Preserve existing millisecond cache primitive contracts while exposing seconds/null service contracts for direct consumer adoption.

  Extend named rate limiters with managed Redis configuration, bounded operation deadlines, reusable in-process insurance, redacted recovery logging and idempotent ownership. Redis quota denials never fail open. Add an optional ioredis peer without changing existing limiter keys or the consume API. Consumers must configure roots once, retain business quotas and response policy locally, and verify isolated Redis failure/recovery before release. No schema migration is required.

- c0de08f: Add API-key issuance, SHA-256 lookup, atomic revocation-aware usage touch, owner-bound management and header-only authentication over the existing DatabaseAdapter. Prefixes, default scopes/quotas, model names and response messages remain explicit consumer options.

  Add atomic rate consumption with a per-subject cap to the configured limiter engine, reusing its Redis deadline and persistent memory insurance instead of per-key clients or read/write counters. Key generation returns the secret once; database and key formats require no migration. Adapter and consumer verification are required before release.

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

### Minor Changes

- Harden framework runtime packaging and public error handling, add controller and global-guard registration controls, unify the database adapter token, bound monitoring samples, expose portable metrics and uptime helpers, redact email delivery logs, and protect rate-limit storage keys.

### Patch Changes

- Add Apache-2.0 license files, framework attribution, bundled third-party notices,
  and public npm publishing metadata to every library. Validate these materials
  in package contents before upload and declare required and optional runtime dependencies.
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @zucker-framework/core@1.0.0
