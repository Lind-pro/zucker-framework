# Authentication

## User lifecycle and role bindings

`UserService.saveUser` remains insert-or-update. Use `updateUser(id, changes)` for
partial updates that must reject a missing account instead of inserting it.
Updates preserve omitted fields and the caller's DTO. Repeating the current
plaintext password preserves its stored hash; new passwords are encoded and
password change events are redacted. Empty/omitted update passwords keep the
existing credential. Creation still applies the configured username/password
validators and defaults to the existing password encoder unless explicitly set.

`setUserRoles(userId, roleIds, { bindingData })` replaces deduplicated bindings in
one `DatabaseAdapter.$transaction` and emits authorization invalidation after
success. The optional mapping supplies consumer-owned relation fields such as
primary keys; it cannot override the user/role identifiers. Table mapping,
authorization to assign roles, and transaction isolation remain explicit
consumer responsibilities. A transaction failure propagates and does not emit
success. In-memory tests do not establish PostgreSQL concurrent-writer isolation.

## Existing scrypt password hashes

`ScryptEncoder` implements the standard `PasswordEncoder` contract (`encode`, `matches`) with Node's asynchronous scrypt and constant-time comparison. It stores `saltHex:derivedKeyHex` using 16 random salt bytes and a 64-byte derived key. For compatibility, the stored salt's hex text is passed to scrypt as the salt. Verification rejects malformed or trailing data. Choose this encoder explicitly for consumers with that stored format; existing encoder defaults are unchanged.

## Direct session and strategy composition

Configure `PersistentSessionService<T>` with the shared database adapter and `PersistentSessionOptions` using a Nest factory provider. `createSession` accepts typed extra fields from the host model; the login flow can provide device metadata without subclassing the service. `revokeSessionForUser(sessionId, userId, reason)` makes ownership part of the database update and reports whether a row was revoked; cache failures do not undo the write. Current-session UI restrictions and privileged administrator actions remain transport policy.

Register `RefreshTokenCookie` directly with `RefreshTokenCookieOptions`. The shared class always writes HttpOnly attributes and preserves them when clearing the cookie. Cookie name/security/lifetime belong to the application.

`PersistentSessionRefreshTokenStore` binds `RefreshTokenService` to the existing persistent session model. Use the **session ID** as the refresh subject and create its owned session before calling `login`. `getSessionById` resolves only the primary key; `replaceRefreshJti` initializes only active, unexpired sessions. Rotation uses the same database compare-and-swap as `PersistentSessionService`; the database's fixed expiry is never extended and missing/revoked sessions never use cache-miss recovery. The consumer must still validate the current account and check session ownership/revocation for each access token. The Server template demonstrates separate access/refresh audiences, HttpOnly transport, transactional ticket consumption and credential-version invalidation using its own schema.

The default menu controller now requires `menu:query/add/update/delete` for administrative operations. Its user-filtered `menu/tree` remains available to authenticated users. Grant the matching permission codes explicitly; authentication alone no longer grants menu modification.

Extend `JwtStrategyBase<Claims>` for custom asynchronous identity validation; it retains Passport JWT extraction, signature and expiration handling. The existing concrete `JwtStrategy` still performs its synchronous default mapping. Consumers no longer need to cast a strategy constructor to hide a return-type mismatch.

## Refresh pairs without a new session table

`RefreshTokenService<Identity>` owns pair issuance and rotation through explicit `verify`, `loadIdentity`, `issue` and `RefreshTokenStore` ports. Configure positive integer `accessTtlSeconds` and `refreshTtlSeconds`; the issuer receives both lifetimes and must enforce them. The verifier must validate signature, allowed algorithm, expiration and refresh token type, then return `{ subject, jti }`. Identity/permissions reload on every refresh. Product eligibility, wire fields, JWT claims, error/status mapping and authenticated logout routing stay in the consumer.

`CacheRefreshTokenStore` preserves existing string JTI values and accepts a `key(subject)` function. Its cache port uses **milliseconds** (adapt second-based cache facades explicitly). All login, rotation and revocation writes must use the same store/lock. `RefreshTokenLock.runExclusive` must serialize across the cache's entire sharing scope; `InProcessRefreshTokenLock` is only suitable for process-local memory and must be shared across service instances. For Redis/multi-process deployments supply a truly atomic store/CAS or a distributed lock with equivalent failure guarantees; do not combine a local mutex with shared storage, or a silently degraded cache. No default persistence replacement is installed.

The default cache-miss policy rejects. Explicit `cacheMissPolicy: 'recover'` permits migration from stateless/evicted legacy JTI entries, atomically admitting at most one refresh while the key remains present. It necessarily allows old JWT recovery after cache loss/restart; use durable authoritative storage if that is unacceptable. Revocation writes a denial tombstone for the full refresh lifetime instead of deleting the key. Configure that lifetime at least as long as any accepted existing refresh JWT's remaining validity. A new authenticated login replaces the tombstone. Revocation must receive an authenticated subject, never unverified body/JWT data.

Signing/loading completes before compare-and-swap so failed issuers do not consume the old JTI. Concurrent losers never receive their prepared tokens; issuers must not publish tokens externally. Store/identity/signing errors propagate (no anonymous or memory fallback). Cache commit uncertainty fails closed; a committed rotation whose response was lost requires reauthentication. `revoke` invalidates refresh credentials only; access-token revocation is a separate `TokenService` policy. Cache eviction is not a durable logout guarantee in recovery mode.

`TokenService` now retains no-cache revocation tombstones independently of session removal until `blacklistTtlMs`; stateless JWTs can be revoked without prior `signIn`. Choose a TTL covering remaining access-token validity. This fallback is still process-local and does not survive restart. Both strict optional and required JWT guards reject ambiguous/trailing Authorization fields before Passport and blacklist lookups can disagree.

## OAuth and login policy

`OAuthStateService` binds signed state to a random HttpOnly browser nonce; cookie attributes, signing/verification and localized errors are explicit configuration. Malformed cookies/payloads fail as state errors. `createOAuthStateGuard(strategy)` wires that mechanism to Passport. `OptionalJwtAuthGuard` permits anonymous access and by default consumes invalid JWT outcomes. Bind `OPTIONAL_JWT_AUTH_OPTIONS` to `{ invalidTokenPolicy: 'reject' }` when absent credentials may be anonymous but supplied malformed/invalid credentials must fail. `createLocalAuthGuard(message)` retains explicit failure wording; its object form `{ message, errorPolicy: 'preserve' }` preserves strategy/infrastructure errors while missing users still receive 401. Defaults remain backward compatible.

`LoginAuditService` writes successful login history and counters in one supplied database transaction; failures write only history. Models, user-agent length and best-effort failure reporting are options. `parseUserAgent` accepts labels separately from device parsing. `PermissionsGuardOptions` can deny authorization failures and select a safe diagnostic identity without mutating the request. Register configured guards once.

## Persistent identity mechanisms

`VerificationCodeService` owns six-digit cryptographic code issuance, resend throttling, latest-code validation, conditional one-time consumption and failure locking. `DatabaseVerificationCodeStore` maps subject/purpose columns to an existing model. Its caller-supplied `IdentityTransactions` must serialize all operations for the subject and keep code consumption and the `consume(..., apply)` local account callback in the same transaction. Mail, sessions and other external effects run after that transaction. `PostgresIdentityTransactions` performs this serialization on the caller's transaction, with no new connection pool.

`CacheVerificationAttemptStore` receives explicit key prefixes/attempt/TTL policy and requires a healthy cache before and after each command. A cache that silently falls back must expose its degraded state. Failure locking must never fall back to an in-memory counter or infer failures from expired verification rows. Counter increments are serialized by the identity transaction; TTL setup failures reject verification. These primitives require one shared authoritative store for all callers; tests using fake ports are not proof of PostgreSQL/Redis isolation.

`OneTimeTicketService` generates 32-byte opaque tokens, persists only SHA-256 hashes, expires/cleans up records and claims through an atomic predicate before returning application payload. `DatabaseOneTimeTicketStore` uses an existing model. Payload, TTL and consumed retention are supplied by the consumer. Once claimed, a later session-creation failure does not restore the ticket.

`ThirdPartyAccountService` accepts configurable binding/user models, same-provider rejection, a safe list projection and `withUserLock`. For concurrency-safe final-login-method protection, configure `withUserLock` with a caller-owned database transaction and a subject lock; the legacy unconfigured adapter transaction alone does not establish that guarantee. `ZuckerAuthModule` exposes these options as `thirdPartyAccounts`. `findAccount`, `refreshAccount`, `bindAccount` and `unbindAccount` let applications retain their own verified-email and user-creation policies; do not use the legacy `findOrCreateUser` email merge policy where the application requires stronger trust.

`PermissionService.importPermissions` uses native atomic upsert or an explicit `persist` callback and supports row mapping while preserving item-level partial success. It invalidates its cache after the batch. Unsupported native upsert produces an item failure, never a find-then-create fallback. The success message is now the single synchronization message; callers needing existing wording configure `successMessage`.

Validation on 2026-09-11: all 24 auth unit-test files (178 tests) passed, including verification codes, tickets, binding, permission imports and module composition. The affected permission/API-key tests were rerun after type fixes (28 passed), and the package no-emit typecheck passed. This does not verify the consumer PostgreSQL/Redis transaction contracts or browser flows. No schema migration or release is included.

### Account deletion schema contract

`UserService.deleteUser(userId, relatedModels)` requires the consumer to list the adapter models whose `userId` records must be removed (for example `['userRoles', 'userPermissions']`). Pass `[]` only when no related cleanup is required. All cleanup and account deletion use one transaction; failures propagate and no success event is published. The previous one-argument contract is removed; no optional-table guessing or compatibility fallback remains.

### Verified OAuth identities and binding proofs

`GoogleIdTokenVerifier` verifies Google One Tap credentials against official JWKS and a server-stored nonce, with bounded caching, rotation and sanitized errors. `OAuthProofService` reuses one-time tickets for distinct login/linking handoffs bound to the browser and, for linking, the authenticated user/session. Wrong context is rejected before claiming. The generic third-party binding endpoint now requires `{ proof }` and a configured `thirdPartyAccounts.resolveBindingProof`; raw client profiles are rejected. Low-level `bindAccount` remains available for trusted server integrations. See [identity verification, proof contracts and transaction boundaries](docs/oauth-identity-proofs.md).

`ApiKeyService.renameApiKey(keyId, userId, name)` performs one atomic, owner-scoped metadata update restricted to an active, unrevoked and unexpired key. It returns only `{ id, name }`; it does not read/return the hash, rotate the secret, change scopes or reactivate a key. A missing owner/key or lost active-state predicate fails closed. Consumer HTTP handlers retain name-length/content policy, allowed origins and a name-only field whitelist; the broader existing administrative update API remains separate.
