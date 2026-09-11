# @zucker-framework/rate-limiter

Configure `ZuckerRateLimiterModule` once at the application composition root. Feature services inject `RateLimiterService` and use named `consume`, `getRemaining`, `reset`, `penalty`, and `reward` operations. Limiter names, points, durations, key prefixes, combined quotas, and HTTP response policy belong to the consumer. `checkLimit(name, key, subjectLimit)` returns `{ allowed, remaining, resetAt }` using the same atomic counter with a per-subject cap. Configure that named limiter at the maximum supported cap and `blockDuration: 0`; window-key policy remains with the consumer, and denied requests advance the counter.

```ts
ZuckerRateLimiterModule.forRoot({
  globalGuard: false,
  redis: { url: applicationRedisUrl, commandTimeoutMs: 500 },
  operationDeadlineMs: 750,
  circuitBreakerMs: 5000,
  limiters: {
    requests: { points: 30, duration: 60, blockDuration: 60, keyPrefix: 'requests:' },
  },
});
```

`forRootAsync` accepts the same options from a factory. Set `globalGuard: false` on its outer options when the consumer performs its own checks. `consume` keeps its existing `TooManyRequestsException` (HTTP 429) and `retryAfter` contract. Consumers may translate that exception to their established product response; connection errors are not quota responses.

`redis` creates and owns one optional `ioredis` connection, with offline queueing and command replay disabled. The `ioredis` peer is loaded only for managed Redis mode. Alternatively, `redisClient` supplies an externally owned client; the service observes and removes its own event handlers, but never connects, disconnects or reconfigures that client. These options are mutually exclusive. The owner of an external client must enforce command deadline/replay safety.

Each named limiter has a long-lived in-memory insurance limiter with the same points, duration and blocking policy. A Redis infrastructure error or operation deadline opens the circuit and uses the insurance limiter. Quota exhaustion from Redis remains a denial and is never retried against a fresh allowance. Consume, quota reads, administrative resets, penalty and reward all use bounded Redis operations. Reset clears the current backend and the insurance state. Logs include only bounded error codes, and `isDistributed()` reports current degradation.

Managed startup connection failure retains process-local limiting for that service instance. A connection that fails after successful startup can reconnect and restore distributed limiting. Shutdown is idempotent and disconnects a managed connection immediately without another Redis command. Module registration uses one service provider; its existing token alias does not create another service instance, and repeated lifecycle calls do not recreate limiters.

Insurance is intentionally per process and does not synchronize consumed points back to Redis. A timed-out distributed consume can already have reached Redis before its local insurance consume; quotas are conservative in that ambiguity. This is not a distributed safety guarantee for multiple independent server processes.

The API extension is additive. Existing named limiter keys and optional key HMAC remain unchanged. Consumers should pin the previous package version and restore their previous composition for rollback; no database migration is required. Regression source covers hanging commands, denied quotas, recovery, reset, redaction, client ownership and initialization failure. No tests or real Redis checks were run for this migration batch.
