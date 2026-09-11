# Persistent API key authentication

`ApiKeyService` accepts the existing `DatabaseAdapter` and `ApiKeyServiceOptions`: key/usage model names, secret prefix, display-prefix length, default scopes/rate limit, localized error messages and a `consumeRateLimit(keyId, limit)` function. No environment variables, application schemas or product names are read by this service.

It generates 24 random bytes encoded as 32 URL-safe characters, prepends the configured prefix, stores a SHA-256 digest and returns the full secret only on creation. Existing digests remain valid. Keys retain active/revoked/expiry checks; an atomic conditional usage touch prevents a key revoked between lookup and authorization from being accepted. List/get projections omit the digest; owner checks are included in mutations. Daily/monthly quota metadata is stored, without inventing additional enforcement semantics.

`ApiKeyGuard` reads Bearer or a configured API-key header, never a URL query parameter. Explicit `allowMissingKey: true` enables a consumer's existing JWT fallback. Successful authentication attaches `{ user: { id }, apiKey: { id, scopes } }`, emits `X-RateLimit-Remaining` and `X-RateLimit-Reset`, and records usage after response completion. Usage logging failures are contained and reported with fixed text. Limit rejection retains an unauthorized response, with its message configured by the consumer.

A consumer can pass `(id, limit) => limiter.checkLimit(configuredName, windowKey(id), limit)` from `@zucker-framework/rate-limiter`; auth depends only on this function contract, avoiding another rate-limiter runtime or client. Configure the named limiter's maximum points to cover supported key quotas and blockDuration to zero. Reuse the already configured root limiter and database adapter.

Tests cover secret storage, key states, revocation races, ownership, header extraction, fallback, rate limits and contained logging failures. They have not been executed during this source-only migration. Real adapter/Redis checks remain required before release. No schema or existing-secret migration is needed; roll back consumer composition and the pinned package together.
