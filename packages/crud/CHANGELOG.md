# @zucker-framework/crud

## 1.0.26

### Patch Changes

- @zucker-framework/cache@1.0.26
  - @zucker-framework/core@1.0.26
  - @zucker-framework/event@1.0.26

## 1.0.25

### Patch Changes

- @zucker-framework/cache@1.0.25
  - @zucker-framework/core@1.0.25
  - @zucker-framework/event@1.0.25

## 1.0.24

### Patch Changes

- @zucker-framework/cache@1.0.24
  - @zucker-framework/core@1.0.24
  - @zucker-framework/event@1.0.24

## 1.0.23

### Patch Changes

- e7c1b6e: Harden account revocation, transactional credential changes, payment-history replay,
  AI task recovery, cache sequence ordering, dynamic transaction reads, browser session
  isolation, CLI execution and streamed output cleanup after the 1.0.18–1.0.21 review.

  Admin user policies may run in the mutation transaction through `userChanging` and
  `userRolesChanging` (including validated role expiries). Consumers retain policy names
  and must use the supplied transaction and a consistent lock order. Credential hooks
  must migrate from post-commit-only `sensitiveFieldsChanged` to
  `sensitiveFieldsChanging(change, tx)`; required revocation writes commit atomically.

  Direct permission replacement removes legacy untyped links by their stored IDs,
  so consumers with a required grant-type field do not receive an invalid null filter.
  Other grant types remain outside that replacement.

  Custom authentication caches must support atomic sequence advancement/reads. Redis
  sequence values are returned as decimal strings before safe-integer validation to
  avoid RESP integer rounding at the JavaScript boundary.

  AI task consumers must apply the supplied expand-only execution-checkpoint migration
  and coordinate worker cutover. Unknown prior submissions are not automatically sent
  again. Payment history must be retained with the ledger; automatic refunds fail closed
  when the historical application evidence needed to restore entitlements is absent.

  These patch-version contract changes require consumer migration and verification;
  source-level tests do not replace installation of the final immutable release.

- Updated dependencies [e7c1b6e]
- Updated dependencies [e7c1b6e]
  - @zucker-framework/cache@1.0.23
  - @zucker-framework/core@1.0.23
  - @zucker-framework/event@1.0.23

## 1.0.22

### Patch Changes

- @zucker-framework/cache@1.0.22
  - @zucker-framework/core@1.0.22
  - @zucker-framework/event@1.0.22

## 1.0.21

### Patch Changes

- @zucker-framework/cache@1.0.21
  - @zucker-framework/core@1.0.21
  - @zucker-framework/event@1.0.21

## 1.0.20

### Patch Changes

- Security and correctness fixes from the core/crud/common/config/cache/event review.

  **crud: secure defaults for generated CRUD (BREAKING where noted)**

  - BREAKING: caller-supplied dynamic queries (`filters`, `filter`, `where`, `terms`, `orderBy`, `includes`, `excludes`) are validated by a `CrudQueryPolicy`. Unknown operators, `AND`/`OR`/`NOT` keys, dotted paths, object (relation) filter values and sensitive fields (`DEFAULT_SENSITIVE_FIELD_PATTERN`: password, secret, api key, token hash, ...) now return 400 instead of being passed to Prisma as raw `where` fragments. Malformed `filters` JSON is a 400 instead of returning the unfiltered set. `FilterOperatorFactory.applyFilter` throws 400 for unknown operators and falls back to the built-in operators when a factory was created with a partial list.
    Migration: configure `protected get queryPolicy()` on the service, or `ZuckerCrudModule.forRoot({ queryPolicy })` / `CRUD_QUERY_POLICY`: `filterableFields` / `sortableFields` / `selectableFields` (allow-lists, which also re-allow a listed sensitive name), `deniedFields`, `sensitiveFieldPattern: false`, `allowedOperators`, `rawFilterFields` (explicit legacy raw passthrough for relation filters).
  - BREAKING: `pageSize` is clamped to 1000 (`maxPageSize`) and unpaged reads (`findAll` without page/pageSize, `_query/no-paging`) take at most 10000 rows (`maxUnpagedRows`, `Infinity` disables). GET query numbers are coerced (`pageIndex=1` no longer becomes page 11) and `includes=a,b` strings are accepted. Excludes-only projections use Prisma `omit`, and `includes` minus `excludes` produces a true-only `select`.
  - BREAKING: generated write routes (`create`, `update`, `saveOrUpdate`, `save`, `createMany`, `updateMany`, and `CrudControllerFactory` create/update) drop server-controlled fields (`creatorId`, `creatorName`, `createdAt`, `createTime`, `modifierId`, `modifierName`, `updatedAt`, `updateTime`, `deletedAt`) and `id` on update, and reject Prisma nested relation writes with 400. Migration: `BaseControllerOptions.writePolicy` (`writableFields`, `serverControlledFields: []` for the old pass-through, `allowNestedWrites`, `allowClientId`). New `createDto` / `updateDto` options set body DTOs for ValidationPipe.
  - BREAKING: `updateMany` (`PUT /batch`) and `deleteMany` (`DELETE /batch`) are opt-in like `saveOrUpdate` (list them in `only` or configure them in `routes`). They are now declared before `/:id`, so they are no longer shadowed on Express. The `where` must be non-empty Prisma scalar syntax with at least one positive condition: no `AND`/`OR`/`NOT`, no relation filters, no sensitive fields, and `in` cannot be empty (`assertSafeBatchWhere`).
  - `queryDto` now applies to every generated query route (GET and POST). `QueryParamDto` gains `pageIndex`, `filter`, `where`, `total`, `parallelPager` and `inferTotal`.
  - `requiredQueryWhere` now also scopes `findOne`, `findByIdOptional`, `findByIds`, `count`, `update`, `delete`, `saveOrUpdate`, `save`, `updateMany`, `deleteMany`, `updateBatch`, `deleteBatch` and `updateManyWithOptimisticLock`. `findAll`, `queryPager`, `countByQuery` and `exists` accept `{ dataAccessTerms, denyFields }`.
  - Entity validation is fail-closed: a `ValidateEventListener` failure rejects the write with `ValidationException`, and `cancel()` in the PREPARE phase now aborts the operation (`OperationCancelledException`).
  - `CreatorEventListener`: with an authenticated user the creator is always the current user. `save` with an id no longer rewrites the creator and creation time of an existing row, and updates strip `creatorId` / `creatorName` / `createdAt`. Opt out with `CREATOR_LISTENER_OPTIONS` `{ trustClientAuditFields: true }`.
  - `CrudService.transaction(fn)` binds the transaction for every CrudService on the same adapter, so `a.create()` plus `b.update()` inside it commit or roll back together. Nested calls join the outer transaction. Plain `adapter.$transaction()` keeps its previous semantics.
  - `TreeService.update` ignores client `path` / `level`. A `parentId` change runs the cycle check and recomputes the subtree path in one transaction. `delete` emits entity events and runs in a transaction, and `moveNode` is transactional with sequential updates.
  - `CacheEnabledService`: per-ID entries are evicted by `save`, `saveOrUpdate`, `updateBatch`, `restore`, `updateMany`, `deleteMany` and `updateManyWithOptimisticLock`. The all-rows key moved to its own namespace (`GET /@all` no longer returns the table). Cache write errors no longer fail reads. `@Cacheable` keys include the model name and a hash of all arguments, and falsy results are cached. Existing cache entries become misses once.
  - `SoftDeleteService`: empty-ID guard, and a racing delete maps to 404. `updateManyWithOptimisticLock` only treats a missing record as a conflict and rethrows other errors. `CrudControllerFactory` registers `@Body`/`@Param` metadata and route decorators for every route.

  **event**

  - `vetoEvent(error)` / `isEventVeto` / `EventVetoError`: subscriber errors marked as vetoes stop dispatch and are re-thrown from `DefaultTopicEventBus.publish`. Other subscriber errors are still logged (now with stack) and isolated. New `publishStrict`. `UnifiedEventBus.publishAndWait` re-throws subscriber failures after all subscribers ran (behaviour change).
  - `CreatorEventListener` (event package): same audit rules as crud, with an optional `{ trustClientAuditFields }` second constructor argument.
  - `ReplayEventBus` / `RedisReplayEventBus`: completed channels are retained for `terminalRetentionMs` (default `channelTtlMs`), so late subscribers receive the terminal event and complete instead of waiting forever. A later event starts a fresh run, and `0` restores the old behaviour. A failed Redis `SUBSCRIBE` errors the streams already handed out so clients reconnect.
  - `matchesTopic` memoises `**` backtracking (no exponential blow-up).

  **core / common** (details in package changelogs)

  - BREAKING `evaluate` / `evaluateTemplate`: expressions run in a fresh realm with data-only context (no host objects, no string code generation, timeout covers microtasks). Functions in the context are no longer callable. Migration: compute values before calling. Expressions must be developer-authored.
  - BREAKING `buildCorsOptions`: a wildcard origin no longer sends credentials unless `allowAnyOriginWithCredentials: true`. Default methods include PUT/PATCH/DELETE/OPTIONS, and default headers are an explicit list.
  - BREAKING `HttpExceptionFilter`: only real `BusinessException`s use the duck-typed business path (third-party errors with `status` and `code` become a generic 500). Out-of-range statuses become 500, and an already-sent response is ended instead of written.
  - BREAKING `RequestContextMiddleware`: `x-tenant-id` is ignored unless `REQUEST_CONTEXT_MIDDLEWARE_OPTIONS` `{ trustTenantHeader: true }`. Unsafe `x-correlation-id` values are replaced.
  - BREAKING `streamPromiseAsSSE`: only 4xx error messages are streamed by default (`formatError` option).
  - A failing afterCommit callback no longer fires rollback callbacks or fails a committed transaction. `scrubSensitive` redacts `Authorization: Bearer|Basic <value>`, `password is X`, cookies and bare JWTs. `mergeConfigs` blocks prototype pollution. `TrimStringPipe` keeps arrays and Dates. `RequestLoggerMiddleware` omits query strings. Shutdown timers are cleared. `ScopedCancellationRegistry.cleanup(key, signal?)` ignores stale signals.

  **config / cache**

  - `LayeredConfigService.set()` updates its cache. Caches are bounded, have a 60 s TTL by default (`cache: { ttlMs: 0 }` restores no expiry) and are evicted through the config change topic when an event bus is injected. Encrypted layered properties are encrypted at rest and redacted in events. BREAKING: writing one without an encryptor throws. `ConfigService.rollback()` throws on failure, and writes no longer fall back to create on errors other than not-found. Cache keys no longer collide on `:`. `ConfigFileWatcher` survives atomic replace.
  - `CacheService` / `RedisCacheService`: invalidations made while Redis is degraded are replayed on recovery (`maxPendingInvalidations`), and the `getOrSet` fence is per key. `incr` is atomic (INCR+EXPIRE Lua) and memory-mode `incr` keeps its first expiry. A TTL ≤ 0 deletes, and a corrupt value is a miss instead of opening the breaker. `@Cacheable` default keys are type-preserving (existing entries miss once). Optional `keyPrefix`. `HybridCache` respects the remaining L2 TTL, and `MemoryCache` evicts expired entries first.

  **Re-review follow-ups (core / crud / event / cache / common)**
  - BREAKING crud: relation `includes` require explicit allow-listing (secure default). With field metadata (`DatabaseAdapter.getModelFields`, new optional; implemented by `PrismaAdapter` from the client's runtime data model) relation and unknown fields in `includes`, `orderBy`, `filters` / `terms` / `where` and batch `where` return 400. Without metadata (`InMemoryAdapter`, custom adapters) included values that look like relation rows (non-null objects other than Date / Buffer / Decimal / arrays of primitives) are removed from results and a warning is logged once per model; JSON columns then need `selectableFields`. Migration, for a relation callers may select:
    ```ts
    protected override get queryPolicy(): CrudQueryPolicy {
      return { selectableFields: ['id', 'name', 'status', 'createdAt', 'roles'] }; // whole related row is returned
    }
    ```
    or module-wide `ZuckerCrudModule.forRoot({ queryPolicy: { selectableFields: [...] } })`. Relation filters stay opt-in through `rawFilterFields`; sorting by a relation is never accepted.
  - BREAKING crud: `DEFAULT_SENSITIVE_FIELD_PATTERN` also matches names ending in `hash` (`keyHash`, `codeHash`), `digest`, `signature`, `cipher`, `encrypted`, `(otp|verification|verify|recovery|backup|invite|reset)_?code(s)`, `jti` and `nonce`. It remains a name-based deny-list: configure `filterableFields` / `selectableFields` allow-lists on models with secrets.
  - BREAKING crud: `QueryParamDto` now declares `terms` and accepts `filters` as a JSON string or an object, so a whitelisting `ValidationPipe` no longer strips POST filters (which widened `_count` / `_query` to the whole table). `DynamicQueryParam.filters` is `string | Record<string, unknown>`.
  - BREAKING crud: malformed filter keys (`$or$`, `$nest` with a non-object, `$eq`) return 400 instead of being skipped. Unpaged results that hit `maxUnpagedRows` carry `truncated: true`. `queryPager` clamps `pageSize` like `findMany`.
  - BREAKING crud: `saveOrUpdate` with an id that does not exist (within `requiredQueryWhere`) now creates the row (it threw 404); `save` / `saveOrUpdate` probe existence before PREPARE and mark entities (`ENTITY_IS_NEW`), so creator fields are filled for new rows with client-generated ids.
  - crud: write routes accept DTO class instances (`ValidationPipe({ transform: true })`); new `writePolicy.deniedFields` (400); a warning is logged when write routes have neither `writableFields`, `deniedFields` nor DTOs. Batch `where` rejects empty `contains` / `startsWith` / `endsWith`, uses the service's caller policy, and `maxBatchRows` (opt-in) counts matches first.
  - crud: `SoftDeleteService` ANDs the subclass constraint (minus `deletedAt`) into by-ID reads, delete, restore, force-delete, `deleteMany` and `includeDeleted` lists; `updateManyWithOptimisticLock` reads conflicts with `scopeWhere`.
  - crud: the service transaction binding is closed when the transaction settles (un-awaited work started inside it uses the root adapter), the proxy forwards extra `$transaction` arguments, and adapter getters run with the real adapter as `this`.
  - BREAKING crud (unlisted before): `CrudService.db` is a Proxy around the injected adapter (`this.db !== adapter`); server-side `update()` calls lose `creatorId` / `creatorName` / `createdAt` through `CreatorEventListener`; `QueryParamDto` (via `queryDto`) applies to all nine query routes, not only `GET /`.
  - BREAKING event: `ReplayEventBus` terminal retention default is `min(channelTtlMs, 30 s)` (it was `channelTtlMs`). Producers reusing channel keys call `bus.begin(context)` (alias `reset`) when a run is accepted; `RedisReplayEventBus.begin` fans out over `controlChannel` (default `zucker:replay-bus:control`). Optional `runId(payload)` + `stream(context, { runId })` ignores another run's retained terminal entry. `terminalRetentionMs: 0` restores the pre-1.0.20 behaviour. Also BREAKING: `UnifiedEventBus.publishAndWait` rethrows handler errors.
  - cache: writes made while Redis is degraded are replayed on recovery as `SET` with the remaining TTL (deletes still as `DEL`) instead of deleting the key, so values such as token revocations are not lost (`RedisCacheService.markPendingWrite`). `@Cacheable` custom keys are remembered up to 10 000 per cache name. BREAKING (unlisted before): `set` with a TTL ≤ 0 deletes the key; `@Cacheable` key formats changed (entries computed by earlier versions miss once).
  - BREAKING common: default CORS `allowedHeaders` is an explicit list; it now also includes the framework's own `X-Tenant-ID`, `X-Auth-Token`, `X-Token`, `X-API-Key`, `Idempotency-Key`, `X-Verify-Code`. Migration: pass `allowedHeaders` for any other custom request header.
  - core / common: `BusinessException` instances carry `Symbol.for('zucker.business-exception')` (`isBusinessException`, `BUSINESS_EXCEPTION_BRAND`); `HttpExceptionFilter` checks the brand before the class name, so minified or renamed classes keep their status and code.

- Updated dependencies
- Updated dependencies
- Updated dependencies [5280170]
  - @zucker-framework/cache@1.0.20
  - @zucker-framework/event@1.0.20
  - @zucker-framework/core@1.0.20

## 1.0.19

### Patch Changes

- @zucker-framework/cache@1.0.19
  - @zucker-framework/core@1.0.19
  - @zucker-framework/event@1.0.19

## 1.0.18

### Patch Changes

- @zucker-framework/cache@1.0.18
  - @zucker-framework/core@1.0.18
  - @zucker-framework/event@1.0.18

## 1.0.17

### Patch Changes

- @zucker-framework/cache@1.0.17
  - @zucker-framework/core@1.0.17
  - @zucker-framework/event@1.0.17

## 1.0.16

### Patch Changes

- @zucker-framework/cache@1.0.16
  - @zucker-framework/core@1.0.16
  - @zucker-framework/event@1.0.16

## 1.0.15

### Patch Changes

- @zucker-framework/cache@1.0.15
  - @zucker-framework/core@1.0.15
  - @zucker-framework/event@1.0.15

## 1.0.14

### Patch Changes

- @zucker-framework/cache@1.0.14
  - @zucker-framework/core@1.0.14
  - @zucker-framework/event@1.0.14

## 1.0.13

### Patch Changes

- @zucker-framework/cache@1.0.13
  - @zucker-framework/core@1.0.13
  - @zucker-framework/event@1.0.13

## 1.0.12

### Patch Changes

- @zucker-framework/cache@1.0.12
  - @zucker-framework/core@1.0.12
  - @zucker-framework/event@1.0.12

## 1.0.11

### Patch Changes

- @zucker-framework/cache@1.0.11
  - @zucker-framework/core@1.0.11
  - @zucker-framework/event@1.0.11

## 1.0.10

### Patch Changes

- Updated dependencies
  - @zucker-framework/cache@1.0.10
  - @zucker-framework/core@1.0.10
  - @zucker-framework/event@1.0.10

## 1.0.9

### Patch Changes

- Add opt-in SELECT-first total inference and public `resolvePageTotal` for custom transactional queries.
- Export `withActiveRecordWhere` and enforce active-record conditions across SoftDeleteService reads, writes, batches, query builders and transaction callbacks.
- Ordinary writes cannot change `deletedAt`; use lifecycle methods. Bulk deletion now retains records, and explicit force deletion supports retained rows. See README for adapter and migration requirements.

## 1.0.8

### Patch Changes

- @zucker-framework/cache@1.0.8
  - @zucker-framework/core@1.0.8
  - @zucker-framework/event@1.0.8

## 1.0.7

### Patch Changes

- @zucker-framework/cache@1.0.7
  - @zucker-framework/core@1.0.7
  - @zucker-framework/event@1.0.7

## 1.0.6

### Patch Changes

- @zucker-framework/cache@1.0.6
  - @zucker-framework/core@1.0.6
  - @zucker-framework/event@1.0.6

## 1.0.5

### Patch Changes

- Updated dependencies
  - @zucker-framework/core@1.0.5
  - @zucker-framework/cache@1.0.5
  - @zucker-framework/event@1.0.5

## 1.0.2

### Patch Changes

- c0de08f: Add CrudEntity and an undecorated CrudService for services with custom Nest constructor layouts. Existing BaseService injection remains supported, and both entries share the same CRUD implementation. Allow BaseController consumers to select routes, configure HTTP methods/paths and decorators, and supply a validated query DTO. Single-record upsert is opt-in. This removes consumer-side metadata overrides without expanding their HTTP surface.
- Align all public Framework packages to the maintainer-selected 1.0.2 release and keep subsequent releases synchronized through a Changesets fixed group. Package dependencies and the CLI scaffold catalog follow the same version.

  This release consolidates the pending API migrations, including breaking auth and payment persistence contracts. Review docs/package-release-1.0.2.md before upgrading from 1.0.0 or 1.0.1.

- c0de08f: Extract consumer-independent cancellation scopes, per-chunk idle timeouts, bounded concurrency admission and timezone helpers; reuse cancellation in the AI adapter. Add signed browser-bound OAuth state, login audit with transactional counters, device parsing and configurable Passport guards. Authorization guards can deny provider errors and select a safe log identity without rewriting request.user.

  Add a validated HTTP query DTO without changing QueryParamEntity. MetadataLogService reuses log persistence for explicitly projected metadata. The optional ai/langchain entry captures call timing and usage without forcing LangChain on other AI consumers.

  Add the single-process task supervisor and temporary export artifact manager. Both preserve their process-local scheduling boundaries: neither introduces durable task storage, distributed leases or multi-executor safety. Consumers retain state transitions, ownership, retry eligibility, prompts, budgets, messages, retention schedules and output policy.

  Source migration only: new APIs, independent test sources and consumers are prepared; verification and immutable publication remain separate pending stages.

  Add durable recipient inbox operations and bounded verified object transfer; retain recipient constraints in updates, reject content collisions, keep dry runs read-only and verify uploaded object bytes before success.

- Updated dependencies [c0de08f]
- Updated dependencies [c0de08f]
- Updated dependencies [c0de08f]
- Updated dependencies
- Updated dependencies [c0de08f]
- Updated dependencies [c0de08f]
- Updated dependencies
- Updated dependencies [c0de08f]
  - @zucker-framework/cache@1.0.2
  - @zucker-framework/core@1.0.2
  - @zucker-framework/event@1.0.2

## 1.0.1

### Patch Changes

- Declare cache/event peers required where the public entry imports their runtime
  tokens unconditionally. This fixes missing modules when consumers install auth,
  crud or rule-engine without the rest of the monorepo. Refresh the CLI scaffold
  catalog so newly generated server projects include the required cache package.
  Refresh credit's packed development dependency metadata for the new CRUD version
  without rebuilding different metadata under an already published credit version.

## 1.0.0

### Major Changes

- First stable public release under the @zucker-framework organization. Publish compiled JavaScript, public type declarations, required runtime assets and Apache-2.0 license materials without source maps.

### Patch Changes

- Add Apache-2.0 license files, framework attribution, bundled third-party notices,
  and public npm publishing metadata to every library. Validate these materials
  in package contents before upload and declare required and optional runtime dependencies.
- Harden framework runtime packaging and public error handling, add controller and global-guard registration controls, unify the database adapter token, bound monitoring samples, expose portable metrics and uptime helpers, redact email delivery logs, and protect rate-limit storage keys.
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @zucker-framework/cache@1.0.0
  - @zucker-framework/core@1.0.0
  - @zucker-framework/event@1.0.0
