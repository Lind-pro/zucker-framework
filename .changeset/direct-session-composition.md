---
"@zucker-framework/auth": minor
---

Add atomic owner-constrained session revocation and a typed JwtStrategyBase extension point for asynchronous product identity validation. Preserve the default JwtStrategy mapping and constructor. Consumers can configure PersistentSessionService and RefreshTokenCookie directly without local wrapper classes; session metadata, cookie names and TTL/cache policy remain application configuration.
