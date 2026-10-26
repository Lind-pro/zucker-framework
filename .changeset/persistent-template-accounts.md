---
"@zucker-framework/auth": patch
---

Expose PersistentSessionRefreshTokenStore to bind the existing token-pair lifecycle to durable, independently revocable sessions without cache-miss resurrection. Add exact session lookup and active-session refresh initialization.

The Server consumer template composes this API with public registration, hashed one-use verification/reset tickets, HttpOnly refresh cookies, owner-scoped sessions, credential-version invalidation and explicit administrator setup. The full template requires its own PostgreSQL migrations and mail configuration; no default administrator password is created on startup. This is local source integration, not a published artifact or a production migration.
