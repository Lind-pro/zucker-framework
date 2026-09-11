# @zucker-framework/cache

`MemoryCache`, `RedisCache`, `HybridCache`, and `ICache` use millisecond TTLs and `undefined` for misses. `MemoryCache` accepts `maxEntries` to evict the oldest inserted key when its configured capacity is reached. Storage remains in the existing primitives. `size` reports resident entries; `getSync` / `setSync` share the same implementation with async `get` / `set` for process-local state whose consumer API must remain synchronous.

For a managed application cache, configure `ZuckerCacheModule` once at the composition root:

```ts
ZuckerCacheModule.forRoot({
  provider: 'fallback',
  preferredProvider: 'redis',
  defaultTtlSeconds: 3600,
  memoryMaxEntries: 1000,
  memoryCleanupIntervalMs: 300000,
  redis: {
    url: applicationRedisUrl,
    commandTimeoutMs: 500,
    operationDeadlineMs: 750,
    circuitBreakerMs: 5000,
  },
});
```

For asynchronous configuration, use `forRootAsync({ mode: 'service', inject, useFactory })` and return the same `provider: 'fallback'` options. Other async modes retain the existing `CACHE_PROVIDER` / `ICache` registration. Features inject the exported services without another root registration.

`CacheService` exposes `get`, `set`, `getOrSet`, `delete`, `exists`, `incr`, `ttl`, `getProviderType`, and `isRedisAvailable`. This service uses **seconds** for TTL and `null` for a miss. `getOrSet` coalesces simultaneous loads per key, clears failed loads, and prevents a load begun before an explicit write, delete, or shutdown from repopulating the cache. Invalidation conservatively fences all earlier loads. Memory capacity and cleanup cadence are consumer configuration.

`RedisCacheService` exposes the same data operations except `getOrSet` and backend selection. It owns one Redis connection, never falls back to process-local data, and returns miss/no-op values when Redis is unavailable: `null`, `false`, `0` for increment, and `-2` for TTL. Applications using database-authoritative sessions should inject this service so a failed cache read remains a database lookup. No URL disables Redis. Only managed Redis mode loads the optional `ioredis` peer.

Redis commands have bounded deadlines, disable offline queues and replay, and reset the connection once per degradation episode. The circuit breaker delays cache reuse even if the connection becomes ready sooner. Invalid non-positive or fractional Redis write TTLs are not converted into immortal keys. Logs expose bounded error codes instead of connection URLs or error text. Shutdown disconnects immediately without issuing a queued `QUIT` command. Each service is registered once, and initialization/destruction are idempotent.

The fallback cache is reconstructable and process-local. It does not provide distributed load fencing, strong cross-backend consistency after an offline deletion, or durable counters. `incr` retains separate Redis INCR/EXPIRE commands; a partial failure between them is not transactional. Cache keys, authoritative loaders, retention limits, and business invalidation triggers belong to consumers.

The new services are additive. Existing millisecond-based primitive APIs and default Redis prefixes are unchanged; service mode uses the caller's original keys without an added prefix. Rollback requires reverting the consumer imports/configuration along with the package version; no database schema or key-format migration is needed.

Regression source covers TTL/capacity, coalescing, invalidation, late completion, write failure, hanging Redis commands, circuit recovery, redaction, and lifecycle ownership. These tests and real Redis acceptance have not been executed for this migration batch.
