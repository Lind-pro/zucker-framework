---
"@zucker-framework/cache": minor
"@zucker-framework/rate-limiter": minor
---

Add managed cache services with bounded Redis degradation, coalesced loads, mutation fencing, configurable memory capacity and explicit single-owner lifecycle. Preserve existing millisecond cache primitive contracts while exposing seconds/null service contracts for direct consumer adoption.

Extend named rate limiters with managed Redis configuration, bounded operation deadlines, reusable in-process insurance, redacted recovery logging and idempotent ownership. Redis quota denials never fail open. Add an optional ioredis peer without changing existing limiter keys or the consume API. Consumers must configure roots once, retain business quotas and response policy locally, and verify isolated Redis failure/recovery before release. No schema migration is required.
