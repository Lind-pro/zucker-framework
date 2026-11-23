# @zucker-framework/core

## 1.0.30

## 1.0.29

## 1.0.28

## 1.0.27

## 1.0.26

## 1.0.25

## 1.0.24

## 1.0.23

## 1.0.22

## 1.0.21

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

  **Re-review follow-ups (core expression evaluation)**
  - BREAKING (behaviour): `evaluate()` returns plain data copies: primitives as is, objects/arrays copied through JSON inside the sandbox (Dates preserved), functions and symbols as `undefined`; a promise or other thenable result throws. Results no longer carry sandbox-realm methods that could run code on the host or outside the timeout. `evaluateTemplate()` converts the value to a string inside the sandbox under the same timeout. Errors thrown by an expression keep their message.
  - An unhandled rejected promise created by an expression (`(async () => { throw 1 })()`) no longer terminates the process: `evaluate()` installs the same process-level guard as `@zucker-framework/script` (one listener per process; host promises keep Node's default behaviour).

- 5280170: Launch baseline (phase 1): plans that grant credits, admin-editable credit packs, product policies,
  transactional mail, block-based landing pages and a `zucker create` workspace.

  **BREAKING: `GET /billing/plans` returns an object instead of an array.** The public catalog is now
  `{ plans, packs, checkout }`: `plans` is the former array (each price gains `credits` and
  `creditExpiry` (`'period'`, days or `null`), plans gain `featured`, `badge`, `highlights` and, for a
  signed-in caller, `current`); `packs` lists purchasable credit packs; `checkout` is
  `{ defaultProvider, allowProviderChoice }`. Migration: read `response.plans` where the array was used.
  A request with a valid bearer token is answered `private, no-store`; an invalid token is treated as
  anonymous. `GET /billing/currencies` is new.

  **New projects default to English.** `zucker create <name> [--locale en|zh]` (and
  `pnpm create @zucker-framework/app <name>`) chooses the default routed locale at creation time;
  the default is `en` and both locales always ship. Existing projects keep their configured locale.

  - payment / fe-types / fe-admin: plan prices carry `credits` and `creditExpiry`; plan presentation
    fields and translations (`nameI18n`, `descriptionI18n`, `badgeI18n`, `highlightsI18n`). New
    `CreditPackCatalogService`, `validateCreditPackWrite` and offer ids `plan:<id>:<interval>:<CUR>` /
    `pack:<id>:<CUR>`. fe-admin adds the Credit packs page (`/credit-packs`, `plans:*` permissions) and
    connection apply-mode badges (hot / restart).
  - credit: `consumeOrder: 'expiry_first'` draws the soonest-expiring lots first (never-expiring last);
    the default stays `'fifo'`.
  - fe-site: site documents version 2 (validator accepts v1 and v2, returns v2) with hero variants,
    logo cloud, stats, steps, testimonials, showcase, pricing, newsletter, blog list, changelog and
    media blocks; every href and image is re-checked with `safeSiteHref`.
  - fe-blocks (new): fetch-free React Server Component renderer (`BlockRenderer`) and theme registry
    (`defineTheme`, `resolveThemeBlock`, `--zb-*` tokens) for validated site documents.
  - core: `classifyAddress`, `resolvePublicAddress`, `assertPublicOutboundUrl`, `createPinnedLookup`,
    `pinnedFetch` and `createPublicFetch` (DNS-pinned, public addresses only, no redirects). The rule
    engine HTTP action uses the same implementation; its behaviour is unchanged.
  - cli / create-app (new): `zucker create` generates a pnpm workspace (`apps/server`, `apps/web`,
    `apps/admin`), Dockerfiles, Docker Compose (PostgreSQL, Redis, MinIO, Mailpit, one-shot
    migrations) and one root `.env` with generated secrets. `zucker doctor` checks key lengths,
    origins, database reachability and migration state.
  - notification: `EmailProvider` no longer attempts SMTP AUTH when user and password are both empty
    (local catchers and IP-allowlisted relays).
  - logging: persisted log values replace U+0000 (PostgreSQL rejects it in text/jsonb, which dropped
    the whole log row).

  Server template (copied by `zucker create` / `zucker init`, not versioned): hot-applied product
  policies (`account`, `billing`) with an admin Policies page; registration switch, optional email
  verification, initial role and welcome credits granted once (in the sign-up transaction, or a retry
  task committed with it); sign-up acquisition data; Resend or SMTP for account and transactional
  mail with editable templates and purchase receipts; `changelog` content kind, file-backed starter
  content (published by `pnpm account:admin`), signed Web cache revalidation; remote file imports
  through `createPublicFetch`; payment callbacks that fail verification answer 400. New scripts
  `pnpm account:role` and `pnpm content:seed`. Run `prisma migrate deploy`: the migrations are
  additive (plan credits and credit packs, account acquisition, changelog kind, starter-data markers
  and the new starter menus).

## 1.0.19

## 1.0.18

## 1.0.17

## 1.0.16

## 1.0.15

## 1.0.14

## 1.0.13

## 1.0.12

## 1.0.11

## 1.0.10

## 1.0.8

## 1.0.7

## 1.0.6

## 1.0.5

### Patch Changes

- Add cancellation deadline ref control, public synchronous/FIFO concurrency leases, non-mutating injectable-RNG shuffle, drain-on-error task mapping, immediate/configurable HTTP disconnect cancellation, and request-aggregate bounded Multer-compatible memory storage.

  Make WebDAV uploads/downloads truly streaming with cancellation/error teardown, directory stat rejection, shallow directory-inclusive listing, public ensureDirectory and explicit anonymous configuration policy. Correct FileManager's download stream type from fs.ReadStream to Node Readable (a breaking public type correction); upload accepts Readable. Hosts retain paths, ownership and disk recovery policy. Local/S3 buffering behavior is unchanged.

## 1.0.2

### Patch Changes

- c0de08f: Centralize browser-safe field redaction and UA inspection in Core public subpaths; keep existing auth and frontend exports backed by those implementations. Add an optional, explicitly configured Sentry adapter, health-check subsets that fail closed when probes are absent, and reusable mail/webhook provider probes. Reuse webhook transport with injectable fetch, redirect policy and typed delivery errors. Add the runtime-template safe link primitive.

  Applications retain routes, business queries, thresholds, field selections, SDK configuration, locale labels, external-call authorization and message content. Sources and independent tests are prepared; verification and immutable release remain pending.

- c0de08f: Add product-neutral immutable image manifest parsing, complete-set merging and source/run/repository/digest verification. Consumers configure component repositories and retain filesystem, CLI, environment and deployment policy. These functions do not query registries, build or publish images.
- c0de08f: Add root-configured persistence for rejected HTTP requests, including guard failures and missing routes, with explicit path exclusions and client-IP retention policy. Add an HTTP error interceptor that preserves normalized request IDs and separates 4xx warnings from server-error stack logging without mutating its host logger context. Export the existing template HTML-escaping primitive for product templates to reuse directly.
- c0de08f: Add SecretCipher for AES-256-GCM/scrypt encrypted fields with explicit key material, stable v2 encoding and opt-in read-only legacy CBC support. Require full GCM authentication tags and reject malformed/plaintext stored values. Add ScryptEncoder implementing PasswordEncoder while preserving the two-part hex salt/derived-key format. Application environment, key selection and accepted historical formats remain consumer configuration; no data rewrite or password reset is required for valid existing records.
- Align all public Framework packages to the maintainer-selected 1.0.2 release and keep subsequent releases synchronized through a Changesets fixed group. Package dependencies and the CLI scaffold catalog follow the same version.

  This release consolidates the pending API migrations, including breaking auth and payment persistence contracts. Review docs/package-release-1.0.2.md before upgrading from 1.0.0 or 1.0.1.

- c0de08f: Extract consumer-independent cancellation scopes, per-chunk idle timeouts, bounded concurrency admission and timezone helpers; reuse cancellation in the AI adapter. Add signed browser-bound OAuth state, login audit with transactional counters, device parsing and configurable Passport guards. Authorization guards can deny provider errors and select a safe log identity without rewriting request.user.

  Add a validated HTTP query DTO without changing QueryParamEntity. MetadataLogService reuses log persistence for explicitly projected metadata. The optional ai/langchain entry captures call timing and usage without forcing LangChain on other AI consumers.

  Add the single-process task supervisor and temporary export artifact manager. Both preserve their process-local scheduling boundaries: neither introduces durable task storage, distributed leases or multi-executor safety. Consumers retain state transitions, ownership, retry eligibility, prompts, budgets, messages, retention schedules and output policy.

  Source migration only: new APIs, independent test sources and consumers are prepared; verification and immutable publication remain separate pending stages.

  Add durable recipient inbox operations and bounded verified object transfer; retain recipient constraints in updates, reject content collisions, keep dry runs read-only and verify uploaded object bytes before success.

## 1.0.0

### Major Changes

- First stable public release under the @zucker-framework organization. Publish compiled JavaScript, public type declarations, required runtime assets and Apache-2.0 license materials without source maps.

### Patch Changes

- Add Apache-2.0 license files, framework attribution, bundled third-party notices,
  and public npm publishing metadata to every library. Validate these materials
  in package contents before upload and declare required and optional runtime dependencies.
- Disable source maps in package builds. Release checks now reject source maps,
  inline source map references and uncompiled TypeScript/JSX implementation files
  while retaining public type declarations and required runtime assets.
