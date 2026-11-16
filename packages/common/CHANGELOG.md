# @zucker-framework/common

## 1.0.23

### Patch Changes

- @zucker-framework/core@1.0.23

## 1.0.22

### Patch Changes

- @zucker-framework/core@1.0.22

## 1.0.21

### Patch Changes

- 305f24b: Back office server hosts (1.0.21). All changes are additive for existing consumers.

  - back-office (new package; needs an initial maintainer publication and its own npm trusted-publisher
    binding before automatic publication): server half of the back office, composed by version.
    Subpaths `/accounts` (`/authorize/*` accounts, sessions, two-factor, OAuth, API keys, deletion,
    avatar, rate limits, bootstrap utilities), `/subscriptions` (plans, entitlements, user
    subscriptions, quota stores, per-resource charges, plan payment write-back and full-refund
    revocation), `/billing` (orders, provider webhooks, subscriptions, refunds incl. plan orders,
    plans-only mode, order recovery), `/management` (management read models and log lists), `/mail`
    (transports, SMTP presets, template catalog, transactional and account mail) and `/settings`
    (encrypted connection settings, hot apply, environment-pinned fields, policies). Model and table
    names, field maps and every optional feature are options.
  - auth (**security behaviour change**): refresh-token reuse detection. Presenting an already rotated
    refresh token revokes its persistent session (`PersistentSessionRefreshTokenStore.reused`), killing the
    successor refresh token and the session's access tokens; a reuse within 10 s of the last rotation is
    only rejected (lost-response retries), and losing a concurrent rotation is not treated as reuse.
    `RefreshTokenOptions.reuseDetection: false` restores the previous behaviour. Rotation now also stamps
    the session's `lastActiveAt`.
  - auth: `UserService.addUser(data, { passwordless, transaction })` creates accounts without a password
    credential and inside a caller-owned transaction; the created-user event is published after commit.
  - payment: `SubscriptionAssignmentService.revokePayment({ userId, reference })` revokes or shortens the
    term a fully refunded payment defined.
  - admin: one log list contract (`parseLogRecordsQuery`, `listLogRecords`, `projectLogRecord`) shared by
    the log controller factories, the back-office management host and fe-admin; `USER_FILTER` accepts
    an exact `typeId`.
  - fe-admin: `plans.presets`, `users.typeOptions`, `users.passwordReset`, users status/type filters,
    `session.reloadOnFocus`, `login.forgotPasswordHref`, `UserPicker` (searchable account picker, used by
    subscription assignment), environment-pinned connection fields shown read-only, parameterized
    `extraPages` paths.
  - back-office/subscriptions: plan assignments take a shared plan lock and plan deletes an exclusive one
    (`locks.plan`, default PostgreSQL advisory locks), so a delete cannot orphan a term without a database
    foreign key. back-office/billing: plans-only mode (`credits: null`) requires `lockAccount`.
    back-office/mail: the verification-code template is a default built-in while the account mailer is on;
    code mail failures are 503.
  - storage: `WEBDAV_STORAGE_CONNECTION_DESCRIPTOR` and `webDavOptionsFromConnection`.
  - common: `TransformInterceptor` passes raw responses through unchanged (`StreamableFile`, `@Sse()`,
    new `@RawResponse()`, a declared or already set non-JSON `Content-Type` such as Prometheus metrics).
  - cli: `zucker add back-office`; the bundled server template now composes `@zucker-framework/back-office`.

- @zucker-framework/core@1.0.21

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
- Updated dependencies [5280170]
  - @zucker-framework/core@1.0.20

## 1.0.19

### Patch Changes

- @zucker-framework/core@1.0.19

## 1.0.18

### Patch Changes

- Shared back office (docs/back-office-rfc.md): plans, user subscriptions, entitlements, quota and mail
  administration, and the first release of `@zucker-framework/fe-admin` (fixed group 1.0.18).

  - `fe-types`: new `@zucker-framework/fe-types/back-office` wire contract (plans with `prices[]`,
    public plans, user subscriptions, quota and mail rows) and the single `PortErrorReason` with the
    `PORT_ERROR` brand and `readPortError`.
  - `payment`: `PlanCatalogService`/`PlanCatalogStore` with per-interval/currency `prices`
    (`month | year | one_time | lifetime`, exact decimal strings, provider references), optimistic
    `revision`, plan offers (`planOfferId`, `resolveOffer`, frozen `PlanPriceSnapshot`) and
    `SubscriptionAssignmentService` with a per-reference payment ledger and explicit precedence
    (`recordPayment` returns `{ outcome, subscription, change }`). Plan exports are explicit.
    `admitPurchase` refuses at checkout a plan purchase whose payment would not improve the term
    (`PlanPurchaseRefusal`: active lifetime, a longer administrator term of another plan, a same-plan
    term covering the first recurring period, a billing provider subscription); same-plan one-time
    terms stack from max(now, current end); `purchasedAt` keeps a term revoked after the purchase
    revoked (outcome `revoked`). Administrator revocation and cancel no longer wait for an unsettled
    checkout. `HostedCheckoutAdapter.quote` (Stripe with `client.prices`, PayPal subscription plans)
    refuses a checkout whose provider price differs from the offer before any order exists.
  - `credit`: `EntitlementService` and `ResourceChargeService` (identity includes the counter, stale
    reservations expire in the charge path, concurrent uses get `in_progress`, confirmation failures
    after successful work are reported, optional caller `tx`).
  - `admin`: plan, user-subscription, quota and mail-log controller factories over `…Port`
    interfaces; branded port errors only; users/roles/permissions list filters are allow-lists with
    database paging.
  - `common`: `HttpExceptionFilter` keeps a port error's `reason`, `issues` and `details` in `result`.
  - `fe-http-client`/`fe-auth`: keepalive cookie refresh with interrupted-exchange marker and timeout
    (`createKeepaliveCookieRefresh`, `createRefreshExchange`) and the cookie session
    (`createCookieSession`, cross-tab sync) used by `fe-admin`. `guardedRefresh` rejects with 401
    while signed out (without exchanging the cookie) and, while only a summary is held, unless the
    token's subject (`subjectOf`, default JWT `sub`) is the summary's user.
  - `fe-admin`: Radix/Tailwind back-office pages, lazy pages and locales.

  Versioning: this stays a patch of the fixed group (1.0.18). As in earlier releases (see
  docs/package-release-1.0.2.md and the scoped payment 1.0.3 release in docs/package-release.md),
  the bump is the maintainer-selected group version, not a semver promise; read the breaking notes
  below before upgrading.

  BREAKING (`@zucker-framework/admin`): the users, roles and permissions `POST …/_query` and
  `POST …/_count` filters are allow-lists (`USER_FILTER`, `ROLE_FILTER`, `PERMISSION_FILTER` via
  `toAdminWhere`). A filter key that is not listed — other columns, relation names, `AND`/`OR`/`NOT`,
  object values, operators other than `$eq`/`$like` — now fails with 400 instead of reaching the
  database. Invalid `pageIndex`/`pageSize` now throw `BadRequestException` (400 with a message)
  instead of `ValidationException` with per-field `errors`. Migration: send only the listed fields
  (use `field$like` for substring search) and read the pagination error from `message` rather than
  `errors.pageIndex`/`errors.pageSize`; products that need more filter fields wrap the controllers
  with their own allow-list.

  Server template integration points (new in this release): `BillingPlanOffers.resolve` receives the
  buyer (`ownerId`), and fulfillment hooks that write plan entitlements declare `plans: true`; a plan
  sale with no such hook fails its fulfillment transaction instead of being fulfilled without the
  entitlement. Verified plan payments that are recorded without changing the term are published as
  `billing.plan-payment-unapplied` outbox events for a refund.

  Breaking (server template and its consumers): the provider-subscription list moved from
  `GET /management/subscriptions` (`billing:query`) to `GET /management/billing-subscriptions`;
  `/management/subscriptions` is now the user plan subscription API (RFC §8.3). `fe-admin` defaults to
  the new path; products still serving the old route must set `endpoints.billingSubscriptions`.

  Migration notes: the template migration `20261109000000_back_office` adds plan/price/payment-ledger
  tables, `billing_orders.configRevision` and `quota_reservations.activeResourceKey` (replacing the
  compound resource unique index). Products with their own quota/plan tables apply the equivalent
  steps listed in RFC §5 with their own constraint names; `BILLING_CATALOG_JSON` subscription offers
  are now only plan seeds once a plan claims them. The same migration ends with an idempotent data
  step that adds the back-office permission rows and the new starter menus (under existing starter
  groups only) to installations created before this release.

- @zucker-framework/core@1.0.18

## 1.0.17

### Patch Changes

- @zucker-framework/core@1.0.17

## 1.0.16

### Patch Changes

- @zucker-framework/core@1.0.16

## 1.0.15

### Patch Changes

- @zucker-framework/core@1.0.15

## 1.0.14

### Patch Changes

- @zucker-framework/core@1.0.14

## 1.0.13

### Patch Changes

- @zucker-framework/core@1.0.13

## 1.0.12

### Patch Changes

- @zucker-framework/core@1.0.12

## 1.0.11

### Patch Changes

- @zucker-framework/core@1.0.11

## 1.0.10

### Patch Changes

- Keep unknown HTTP exception diagnostics out of default logs. ORM and provider errors can embed
  submitted data or credential hashes in their message and stack. Preserve the generic response and
  the explicit onServerError hook for application-controlled, redacted diagnostics.
- @zucker-framework/core@1.0.10

## 1.0.8

### Patch Changes

- @zucker-framework/core@1.0.8

## 1.0.7

### Patch Changes

- @zucker-framework/core@1.0.7

## 1.0.6

### Patch Changes

- @zucker-framework/core@1.0.6

## 1.0.5

### Patch Changes

- Add cancellation deadline ref control, public synchronous/FIFO concurrency leases, non-mutating injectable-RNG shuffle, drain-on-error task mapping, immediate/configurable HTTP disconnect cancellation, and request-aggregate bounded Multer-compatible memory storage.

  Make WebDAV uploads/downloads truly streaming with cancellation/error teardown, directory stat rejection, shallow directory-inclusive listing, public ensureDirectory and explicit anonymous configuration policy. Correct FileManager's download stream type from fs.ReadStream to Node Readable (a breaking public type correction); upload accepts Readable. Hosts retain paths, ownership and disk recovery policy. Local/S3 buffering behavior is unchanged.

- Updated dependencies
  - @zucker-framework/core@1.0.5

## 1.0.3

### Patch Changes

- Add `parseJsonWithArrayRecovery(raw, arrayKey)` to retain complete object entries from a truncated top-level JSON array without completing partial values. Preserve preceding fields, reject malformed or ambiguous recovery input, and leave existing JSON parsing and repair APIs unchanged. Consumers retain schema validation and partial-result policy.
- Publish this additive API as a scoped patch at the maintainer's explicit request.

## 1.0.2

### Patch Changes

- 3a5d2e2: Pass Nest StreamableFile responses through the response interceptor unchanged. Add an optional rejectOnError mode to pLimit that rejects the original failure and stops dispatching queued work, while preserving error-as-result behavior by default.
- c0de08f: Add graph update consumption to the public AI LangChain entry and support full message histories, reply whitespace policy and usage metadata in its text collector. Existing prompt callers retain trimmed output.

  Add a single-execution heartbeat scope with serial heartbeats, typed heartbeat failure, caller cancellation forwarding and cleanup. It has no lease, worker or persistence policy.

  Add subscription-based SSE with serialized asynchronous transforms, terminal delivery, snapshot and disconnect cleanup. Disconnecting this stream never cancels the producer.

- c0de08f: Add response formatting/server-error hooks to the existing HTTP exception filter, configurable correlation header/request-property mapping, and error/slow-request observation hooks on the HTTP logger. Extend the existing ErrorTracker with bounded fixed-window retention, fingerprints, redaction and first-occurrence policy. Consumers can directly configure shared mechanisms without response-object shims, local request-ID middleware, duplicate error interceptors or timer-based deduplication services. Default Framework behavior remains compatible.

  Host configuration can assign 5xx stack logging to its exception filter while the shared interceptor handles observation and 4xx warnings. Reporting and observation callbacks do not replace the original exception/response when they fail.

- c0de08f: Expose configurable access and operation log management controllers backed by the shared persistent logging services. Hosts select routes, permission resources and audit labels while reusing pagination, statistics, timelines, bounded deletion and retention endpoints.

  Add read-only record controllers with allowlisted equality filters compatible with the frontend query encoding, and shared log query/CSV controllers. Export an RFC 5987 attachment-header formatter with an escaped ASCII fallback.

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
- Updated dependencies [c0de08f]
- Updated dependencies
- Updated dependencies [c0de08f]
  - @zucker-framework/core@1.0.2

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
  - @zucker-framework/core@1.0.0
