# @zucker-framework/config

## 1.0.22

### Patch Changes

- @zucker-framework/core@1.0.22
  - @zucker-framework/crud@1.0.22
  - @zucker-framework/feature-flags@1.0.22

## 1.0.21

### Patch Changes

- @zucker-framework/core@1.0.21
  - @zucker-framework/crud@1.0.21
  - @zucker-framework/feature-flags@1.0.21

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

- 1696a82: Platform hardening (phase 4): every connection profile applies without a restart, payment credentials
  are kept per revision, and generated projects ship assistant skills. All changes are additive.

  - config: new subpath `@zucker-framework/config/connections` with the connection-profile machinery
    (`defineConnectionProfile`, `composeConnectionProfiles`, field validation, the
    endpoint-follows-secret rule), `ConnectionProfileStore` (advisory lock, revision compare-and-swap,
    same-transaction audit callback, encrypted revision archive in `connection_profile_revisions`,
    `deleteRevisions` that never deletes the current revision), `ConnectionRuntime` (`environment`,
    `liveEnvironment`, `environmentAt`, `revisions`, `currentRevision`) and `RuntimeProviderSlot`
    (`ttl` or `strict` freshness, leased instances disposed after their last user, a failed build keeps
    the previous instance). The package root export is unchanged.
  - payment: `HostedCheckoutOptions.providers` also accepts a resolver (`ids`, `current`, `forOrder`,
    `webhookCandidates`, at most 8 candidates, own account only); the service captures one adapter per
    operation, and a verified webhook can never settle an order of another account scope. The existing
    array form behaves as before. `staticHostedCheckoutProviders` is exported. Orders may carry a
    `configRevision`.
  - auth, notification, storage, ai, payment: plain-data connection descriptors
    (`connection-descriptor.ts`, one export each) with stable ids, environment keys and label keys; no
    new dependency.
  - cli: project-template bundles carry an optional `skills` field; `create` and `init` install the
    bundled skills (brand quick-start, page builder, feature builder, provider setup, deploy checklist)
    into `.agents/skills` with `.claude/skills` links, never overwriting, never following links out of the
    project, and only warning when a directory is unwritable. New exports `installConsumerAgentSkills`,
    `validateConsumerSkills` and `CONSUMER_SKILL_LIMITS` in `@zucker-framework/cli/agent-instructions`.
  - fe-admin: the Connections page shows per-profile apply errors (`applyError`), the retained revision
    count and the payment hot-apply notice, and asks for confirmation before a private-storage location
    change (409 `DATA_LOCATION_CHANGE_UNACKNOWLEDGED`), resending with `acknowledgeDataLocationChange`.

  Templates (not published packages): payment, sign-in, mail, delivery, storage and AI profiles are
  `applyMode: 'hot'`. New payment orders record `payment-<id>@<revision>` and use the current revision;
  existing orders, subscriptions and refunds use the newest retained revision of their own account (D12).
  Superseded payment revisions are purged only by an operator, older than
  `CONNECTION_REVISION_RETENTION_DAYS` (default and minimum 400; D13). A storage location change while files
  exist needs explicit acknowledgement (D14). New migration `20261112010000_connection_revisions` (it
  archives the current revision of each saved profile at start-up). New server script `content:check`.
  Dockerfiles accept an optional `NPM_REGISTRY` build argument (default unchanged).

  Generated workspace fixes found by the packed-artefact launch acceptance (`pnpm acceptance:launch`):
  - The compose stack could not start: MinIO no longer publishes pullable community images, and production
    refused the internal `http://minio:9000` endpoint. Storage is now SeaweedFS (`chrislusf/seaweedfs:4.01`,
    service still named `minio`, same `MINIO_*`/`FILES_S3_*` keys, app account limited to its bucket), and
    `FILES_S3_INTERNAL_HTTP=true` (environment only) allows plain http to a single-label private host.
  - CMS publish revalidation now reaches Web inside compose (`REVALIDATE_URL=http://web:3000`, and the web
    container receives `REVALIDATE_SECRET`); before, published pages stayed stale for the cache lifetime.
  - `pnpm setup:admin` seeds two example plans and one example credit pack (not purchasable until a
    provider price is added) when `BILLING_CATALOG_JSON` has no offers.

- Updated dependencies
- Updated dependencies
- Updated dependencies [5280170]
  - @zucker-framework/crud@1.0.20
  - @zucker-framework/core@1.0.20
  - @zucker-framework/feature-flags@1.0.20

## 1.0.19

### Patch Changes

- @zucker-framework/core@1.0.19
  - @zucker-framework/crud@1.0.19
  - @zucker-framework/feature-flags@1.0.19

## 1.0.18

### Patch Changes

- @zucker-framework/core@1.0.18
  - @zucker-framework/crud@1.0.18
  - @zucker-framework/feature-flags@1.0.18

## 1.0.17

### Patch Changes

- @zucker-framework/core@1.0.17
  - @zucker-framework/crud@1.0.17
  - @zucker-framework/feature-flags@1.0.17

## 1.0.16

### Patch Changes

- @zucker-framework/core@1.0.16
  - @zucker-framework/crud@1.0.16
  - @zucker-framework/feature-flags@1.0.16

## 1.0.15

### Patch Changes

- @zucker-framework/core@1.0.15
  - @zucker-framework/crud@1.0.15
  - @zucker-framework/feature-flags@1.0.15

## 1.0.14

### Patch Changes

- @zucker-framework/core@1.0.14
  - @zucker-framework/crud@1.0.14
  - @zucker-framework/feature-flags@1.0.14

## 1.0.13

### Patch Changes

- @zucker-framework/core@1.0.13
  - @zucker-framework/crud@1.0.13
  - @zucker-framework/feature-flags@1.0.13

## 1.0.12

### Patch Changes

- @zucker-framework/core@1.0.12
  - @zucker-framework/crud@1.0.12
  - @zucker-framework/feature-flags@1.0.12

## 1.0.11

### Patch Changes

- @zucker-framework/core@1.0.11
  - @zucker-framework/crud@1.0.11
  - @zucker-framework/feature-flags@1.0.11

## 1.0.10

### Patch Changes

- Route public package-root imports and requires to the existing matching ESM/CJS runtime and type artifacts. Previously, native ESM imports of these packages fell back to their CommonJS main entry, mixing auth/core provider classes with an application's ESM instances and breaking Nest dependency injection. Keep package.json metadata readable and preserve the existing main/module artifacts.

  Add a native Node regression for both module formats that checks package resolution, shared auth/guard identity and an Admin/Nest composition using a synthetic memory adapter. This does not make mixed import/require copies of a dual package interchangeable and does not replace persistent consumer validation. No service implementation, guard registration or access policy is relaxed.

  Use the CommonJS default export for eventemitter2 in config, dictionary and logging, with an explicit injection token referencing the original constructor. This fixes native ESM loading while retaining the shared Nest event emitter; no dependency is bundled or duplicated.

- Keep encrypted configuration values out of history and change events; mark protected events for trusted reloads, fail closed without encryption or on decryption errors, and refuse history-based credential restoration. Publish batch cache changes only after a successful transaction. Existing plaintext history is masked on reads but is not automatically rewritten.
- @zucker-framework/crud@1.0.10
  - @zucker-framework/core@1.0.10
  - @zucker-framework/feature-flags@1.0.10

## 1.0.8

### Patch Changes

- @zucker-framework/core@1.0.8
  - @zucker-framework/crud@1.0.8
  - @zucker-framework/feature-flags@1.0.8

## 1.0.7

### Patch Changes

- @zucker-framework/core@1.0.7
  - @zucker-framework/crud@1.0.7
  - @zucker-framework/feature-flags@1.0.7

## 1.0.6

### Patch Changes

- @zucker-framework/core@1.0.6
  - @zucker-framework/crud@1.0.6
  - @zucker-framework/feature-flags@1.0.6

## 1.0.5

### Patch Changes

- Updated dependencies
  - @zucker-framework/core@1.0.5
  - @zucker-framework/crud@1.0.5
  - @zucker-framework/feature-flags@1.0.5

## 1.0.2

### Patch Changes

- Align all public Framework packages to the maintainer-selected 1.0.2 release and keep subsequent releases synchronized through a Changesets fixed group. Package dependencies and the CLI scaffold catalog follow the same version.

  This release consolidates the pending API migrations, including breaking auth and payment persistence contracts. Review docs/package-release-1.0.2.md before upgrading from 1.0.0 or 1.0.1.

- Updated dependencies [c0de08f]
- Updated dependencies [c0de08f]
- Updated dependencies [c0de08f]
- Updated dependencies [c0de08f]
- Updated dependencies [c0de08f]
- Updated dependencies
- Updated dependencies [c0de08f]
  - @zucker-framework/core@1.0.2
  - @zucker-framework/crud@1.0.2
  - @zucker-framework/feature-flags@1.0.2

## 1.0.1

### Patch Changes

- Updated dependencies
  - @zucker-framework/crud@1.0.1

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
  - @zucker-framework/core@1.0.0
  - @zucker-framework/crud@1.0.0
  - @zucker-framework/feature-flags@1.0.0
