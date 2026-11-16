# @zucker-framework/fe-permission

## 1.0.23

### Patch Changes

- Updated dependencies [e7c1b6e]
- Updated dependencies [e7c1b6e]
  - @zucker-framework/fe-auth@1.0.23

## 1.0.22

### Patch Changes

- Updated dependencies [aee88b9]
  - @zucker-framework/fe-auth@1.0.22

## 1.0.21

### Patch Changes

- @zucker-framework/fe-auth@1.0.21

## 1.0.20

### Patch Changes

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

- Updated dependencies [f21f444]
- Updated dependencies
  - @zucker-framework/fe-auth@1.0.20

## 1.0.19

### Patch Changes

- @zucker-framework/fe-auth@1.0.19

## 1.0.18

### Patch Changes

- Updated dependencies
  - @zucker-framework/fe-auth@1.0.18

## 1.0.17

### Patch Changes

- Updated dependencies
  - @zucker-framework/fe-auth@1.0.17

## 1.0.16

### Patch Changes

- @zucker-framework/fe-auth@1.0.16

## 1.0.15

### Patch Changes

- @zucker-framework/fe-auth@1.0.15

## 1.0.14

### Patch Changes

- @zucker-framework/fe-auth@1.0.14

## 1.0.13

### Patch Changes

- @zucker-framework/fe-auth@1.0.13

## 1.0.12

### Patch Changes

- @zucker-framework/fe-auth@1.0.12

## 1.0.11

### Patch Changes

- @zucker-framework/fe-auth@1.0.11

## 1.0.10

### Patch Changes

- @zucker-framework/fe-auth@1.0.10

## 1.0.8

### Patch Changes

- @zucker-framework/fe-auth@1.0.8

## 1.0.7

### Patch Changes

- @zucker-framework/fe-auth@1.0.7

## 1.0.6

### Patch Changes

- @zucker-framework/fe-auth@1.0.6

## 1.0.5

### Patch Changes

- @zucker-framework/fe-auth@1.0.5

## 1.0.2

### Patch Changes

- c0de08f: Add reusable client CRUD, typed auth stores with consumer logout/permission hooks, best-effort browser storage, portable Mermaid sanitization/layout/rendering, and shared template placeholders.
- Align all public Framework packages to the maintainer-selected 1.0.2 release and keep subsequent releases synchronized through a Changesets fixed group. Package dependencies and the CLI scaffold catalog follow the same version.

  This release consolidates the pending API migrations, including breaking auth and payment persistence contracts. Review docs/package-release-1.0.2.md before upgrading from 1.0.0 or 1.0.1.

- Updated dependencies [d8b086d]
- Updated dependencies [c0de08f]
- Updated dependencies [c0de08f]
- Updated dependencies [c0de08f]
- Updated dependencies
  - @zucker-framework/fe-auth@1.0.2

## 1.0.0

### Major Changes

- First stable public release under the @zucker-framework organization. Publish compiled JavaScript, public type declarations, required runtime assets and Apache-2.0 license materials without source maps.

### Patch Changes

- Add Apache-2.0 license files, framework attribution, bundled third-party notices,
  and public npm publishing metadata to every library. Validate these materials
  in package contents before upload and declare required and optional runtime dependencies.
- Updated dependencies
- Updated dependencies
  - @zucker-framework/fe-auth@1.0.0
