# Authentication

## Existing scrypt password hashes

`ScryptEncoder` implements the standard `PasswordEncoder` contract (`encode`, `matches`) with Node's asynchronous scrypt and constant-time comparison. It stores `saltHex:derivedKeyHex` using 16 random salt bytes and a 64-byte derived key. For compatibility, the stored salt's hex text is passed to scrypt as the salt. Verification rejects malformed or trailing data. Choose this encoder explicitly for consumers with that stored format; existing encoder defaults are unchanged.

## Direct session and strategy composition

Configure `PersistentSessionService<T>` with the shared database adapter and `PersistentSessionOptions` using a Nest factory provider. `createSession` accepts typed extra fields from the host model; the login flow can provide device metadata without subclassing the service. `revokeSessionForUser(sessionId, userId, reason)` makes ownership part of the database update and reports whether a row was revoked; cache failures do not undo the write. Current-session UI restrictions and privileged administrator actions remain transport policy.

Register `RefreshTokenCookie` directly with `RefreshTokenCookieOptions`. The shared class always writes HttpOnly attributes and preserves them when clearing the cookie. Cookie name/security/lifetime belong to the application.

Extend `JwtStrategyBase<Claims>` for custom asynchronous identity validation; it retains Passport JWT extraction, signature and expiration handling. The existing concrete `JwtStrategy` still performs its synchronous default mapping. Consumers no longer need to cast a strategy constructor to hide a return-type mismatch.

## OAuth and login policy

`OAuthStateService` binds signed state to a random HttpOnly browser nonce; cookie attributes, signing/verification and localized errors are explicit configuration. Malformed cookies/payloads fail as state errors. `createOAuthStateGuard(strategy)` wires that mechanism to Passport. `OptionalJwtAuthGuard` permits anonymous access and consumes invalid JWT authentication outcomes; `createLocalAuthGuard(message)` retains explicit failure wording.

`LoginAuditService` writes successful login history and counters in one supplied database transaction; failures write only history. Models, user-agent length and best-effort failure reporting are options. `parseUserAgent` accepts labels separately from device parsing. `PermissionsGuardOptions` can deny authorization failures and select a safe diagnostic identity without mutating the request. Register configured guards once.

## Persistent identity mechanisms

`VerificationCodeService` owns six-digit cryptographic code issuance, resend throttling, latest-code validation, conditional one-time consumption and failure locking. `DatabaseVerificationCodeStore` maps subject/purpose columns to an existing model. Its caller-supplied `IdentityTransactions` must serialize all operations for the subject and keep code consumption and the `consume(..., apply)` local account callback in the same transaction. Mail, sessions and other external effects run after that transaction. `PostgresIdentityTransactions` performs this serialization on the caller's transaction, with no new connection pool.

`CacheVerificationAttemptStore` receives explicit key prefixes/attempt/TTL policy and requires a healthy cache before and after each command. A cache that silently falls back must expose its degraded state. Failure locking must never fall back to an in-memory counter or infer failures from expired verification rows. Counter increments are serialized by the identity transaction; TTL setup failures reject verification. These primitives require one shared authoritative store for all callers; tests using fake ports are not proof of PostgreSQL/Redis isolation.

`OneTimeTicketService` generates 32-byte opaque tokens, persists only SHA-256 hashes, expires/cleans up records and claims through an atomic predicate before returning application payload. `DatabaseOneTimeTicketStore` uses an existing model. Payload, TTL and consumed retention are supplied by the consumer. Once claimed, a later session-creation failure does not restore the ticket.

`ThirdPartyAccountService` accepts configurable binding/user models, same-provider rejection, a safe list projection and `withUserLock`. For concurrency-safe final-login-method protection, configure `withUserLock` with a caller-owned database transaction and a subject lock; the legacy unconfigured adapter transaction alone does not establish that guarantee. `ZuckerAuthModule` exposes these options as `thirdPartyAccounts`. `findAccount`, `refreshAccount`, `bindAccount` and `unbindAccount` let applications retain their own verified-email and user-creation policies; do not use the legacy `findOrCreateUser` email merge policy where the application requires stronger trust.

`PermissionService.importPermissions` uses native atomic upsert or an explicit `persist` callback and supports row mapping while preserving item-level partial success. It invalidates its cache after the batch. Unsupported native upsert produces an item failure, never a find-then-create fallback. The success message is now the single synchronization message; callers needing existing wording configure `successMessage`.

Validation on 2026-09-11: all 24 auth unit-test files (178 tests) passed, including verification codes, tickets, binding, permission imports and module composition. The affected permission/API-key tests were rerun after type fixes (28 passed), and the package no-emit typecheck passed. This does not verify the consumer PostgreSQL/Redis transaction contracts or browser flows. No schema migration or release is included.
