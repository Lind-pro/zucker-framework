# @zucker-framework/logging

## 1.0.29

### Patch Changes

- @zucker-framework/core@1.0.29

## 1.0.28

### Patch Changes

- @zucker-framework/core@1.0.28

## 1.0.27

### Patch Changes

- @zucker-framework/core@1.0.27

## 1.0.26

### Patch Changes

- @zucker-framework/core@1.0.26

## 1.0.25

### Patch Changes

- @zucker-framework/core@1.0.25

## 1.0.24

### Patch Changes

- @zucker-framework/core@1.0.24

## 1.0.23

### Patch Changes

- @zucker-framework/core@1.0.23

## 1.0.22

### Patch Changes

- @zucker-framework/core@1.0.22

## 1.0.21

### Patch Changes

- @zucker-framework/core@1.0.21

## 1.0.20

### Patch Changes

- Security and robustness fixes for AI, storage, media and observability.

  **logging**
  - `PiiFilter` redaction is linear in input size: emails are matched around each `@`, private keys without a regex scan, and every pattern is bounded. Previously a 16 KiB string could block the event loop for about 0.5 s per pass. New `maxTotalStringLength` (default 256 KiB) caps the string work for one record.
  - Sensitive field names are matched case-insensitively after normalisation, by fragment (`password`, `secret`, `apikey`, `authorization`, `cookie`, `credential`, `accesskey`, `captcha`, `csrf`, ...) and by suffix (`token`, `otp`, `signature`, `sessionid`, `smscode`, `verificationcode`, ...). `newPassword`, `x-api-key`, `idToken` and `smsCode` are now redacted; `maxTokens` and `statusCode` are not. New value patterns redact `sk-…`, GitHub, Google, Slack and Stripe keys.
  - Phone and ID-card patterns require digit boundaries, so long numeric ids and timestamps are no longer corrupted.
  - New `PiiFilter.sanitizeHeaders()`, `isSensitiveField()`, `sanitizeUrl()` and `extend()`. `AccessLoggerInterceptor` redacts any header whose name mentions auth/token/secret/key/cookie/signature/session/credential.
  - **BREAKING (behaviour):** `AccessLoggerInterceptor` redacts request parameters named `code`, `otp` and `captcha` on every `@AccessLogger` route, with no per-route opt-out (a coupon `code` or a Mermaid `code` body field is lost from access/operation logs too; log such values under another name). `allowedFields: ['code']` would also un-redact OAuth codes.
  - The stored `requestUrl` is redacted with the same field list as `parameters` (`PiiFilter.sanitizeUrl`), so `?code=…` no longer survives in the URL while `parameters.query.code` is `[REDACTED]`. `RejectedRequestLoggerMiddleware` and `HttpRequestObservationMiddleware` redact `code`, `state`, `otp`, `captcha` and `ticket` query/fragment parameters in stored URLs.
  - **BREAKING (behaviour):** field-name matching redacts more names than before, including non-secret ones such as `sessionId`, `sid`, `pin` and anything ending in `token`/`otp`/`signature`, and replaces the value with the string `[REDACTED]` whatever its original type. To limit false positives: boolean values are never redacted (`hasApiKey: true`); names that only match a fragment rule are kept when they end in a descriptor (`…At`, `…Time`, `…Date`, `…Count`, `…Length`, `…Url`/`…Uri`, `…Type`, `…Policy`, `…Consent`, `…Enabled`, `…Required`, `…Id`, `…Status`) or start with `has`/`is`/`should`/`requires`/`can` (`passwordChangedAt`, `authorizationUrl`, `credentialId`, `cookieConsent`); `costPerToken`-style names are kept. `sessionId` stays redacted (often a bearer secret); use `allowedFields` to keep a non-secret one readable.
  - ID-card and card-number patterns redact only numbers with a valid check digit (GB 11643 / Luhn), so 18-digit snowflake ids and 16-digit order numbers stay readable. A `BEGIN … PRIVATE KEY` block without an `END` line (for example cut by truncation) is redacted to the end of the string, and `redis://:password@host` (empty user) is redacted. Custom `PiiPattern`s may set `validate(match)`.
  - Sanitized objects keep a `__proto__` key as an own property instead of changing the result's prototype.
  - **Behaviour change:** `@AccessLogger({ excludeFields })` now adds to the built-in sensitive fields instead of replacing the default list.
  - `AccessLoggerInterceptor` catches `bus.publish` rejections (no unhandled rejection) and ignores exceptions thrown by log listeners.
  - **BREAKING (behaviour):** rejected-request logging (`RejectedRequestLoggerMiddleware`) and the rejected **and slow-request** details from `HttpRequestObservationMiddleware` are rate-limited by default, per 60 s window: 20 per status and client, 300 per status code, 1200 non-5xx in total, and a separate budget of 300 for 5xx that 4xx floods cannot consume. Each closed window with dropped rows writes one `http:suppressed` row ("<n> rejected requests not persisted"). Options: `maxPerKey`, `maxPerStatus`, `maxTotal`, `maxServerErrors`, `windowMs`; opt out with `rejectedRequests.rateLimit: false` / `httpObservation.detailRateLimit: false`. `RejectedLogRateLimiter` is exported.
  - **Behaviour change:** the stored client IP for rejected requests is `request.ip` (which honours Express `trust proxy`), never the raw `X-Forwarded-For` / `X-Real-IP` header. Migration: configure `app.set('trust proxy', …)` for your proxy chain.

  **monitoring**
  - **BREAKING:** importing `ZuckerMonitoringModule` directly now mounts only `/health`. `GET /metrics` and `/monitoring/alerts` are opt-in through `ZuckerMonitoringModule.forRoot({ metrics, alerts, authorize })`. Migration: use `forRoot({ alerts: true, metrics: true, permissions: 'host-guard' })` (a global permissions guard enforces the `monitoring:query` / `monitoring:update` metadata) or `forRoot({ …, authorize })`; `forRoot` throws when `metrics: true` / `alerts: true` has neither, because the module's own guard only checks that `request.user.id` is set (any signed-in user would pass). Host authentication must be a global guard so `request.user` is set first. The two codes are not seeded by any template; grant them to operator roles by hand. Or use `metrics: { token }` (≥ 32 characters) for a public scrape endpoint checked by `Authorization: Bearer`. Grant the permission codes to operator roles.
  - Alert acknowledge/resolve record `request.user.id` as the actor; the body `userId` is ignored. Rule bodies are validated (`parseAlertRule`) and limited to 500 rules. `removeRule` also deletes the `alertRules` row.
  - Bounded in-process state:
    - `ErrorTracker` has `maxEntries` (default 1000, LRU).
    - Metrics keep at most 1000 label sets each (extra sets go to `{overflow="true"}`).
    - `InMemoryMetricsCollector` has bounded histogram points and O(1) lookups.
    - Resolved alerts are capped at 1000.

  **tracing**
  - The server span recorded by `TraceInterceptor` uses the span id sent in the response `traceparent` (new `getCurrentSpanId()`; `getSpanId()` still returns the upstream parent).
  - `traceparent` flags and all-zero ids are validated, and `tracestate` is validated before it is echoed.
  - Spans store the URL path without the query string and the client IP from `request.ip` only; stacks are truncated to 4 KiB.

  **media**
  - **BREAKING:** `sanitizeSvgMarkup` is a single-pass parser that rebuilds the SVG from an element/attribute allow-list.
    - Removed: scripts, `foreignObject`, event handlers, external/`javascript:` hrefs (checked after decoding entities), external CSS `url()`/`@import`, and animations that target `href`/`on*`.
    - Malformed markup, `<svg/attr…>` and inputs over 10 MiB (`{ maxLength }`) return `null`.
    - Output is re-serialised: double-quoted attributes, no comments.
    - The XML declaration is accepted only in the strict `version`/`encoding`/`standalone` form and re-emitted as the fixed `<?xml version="1.0" encoding="UTF-8"?>`; any other declaration returns `null` (a crafted declaration was copied verbatim and became live HTML when the result was inlined).
    - An `&` that does not start an XML reference is escaped (`&lpar;`, `&#40` without `;` and `&nbsp;` become literal text), CSS `image-set()`, `image()`, `src()`, `cross-fade()`, `element()` and `paint()` are removed like external `url()`, and elements inside `title`/`desc` are not emitted (their text, including nested text, is kept).
    - Migration: do not compare output byte-for-byte, and inline external images as `data:` URIs.
  - Vega-Lite rendering refuses URL data sources and all external loads (`DENY_ALL_VEGA_LOADER`).
  - The SVG render and Kroki clients cap response size (`maxResponseBytes`, default 20 MiB) and report invalid JSON as `SvgRenderRequestError`.

  **storage**
  - `LocalFileStorage.abortChunkedUpload` ignores unknown upload ids and confines chunk paths to the storage root (previously `../` ids could delete directories). Chunk counts and indices must be bounded integers (`maxChunks`), and abandoned sessions expire (`chunkSessionTtlMs`, default 24 h). Writes (including `completeChunkedUpload`) are atomic through a `.upload-<uuid>.tmp` file next to the target, which `list()` skips, so long target names (up to 255 bytes) still work. `uploadStream` streams to disk. **Behaviour change:** `downloadRange` throws `RangeError` for a start position outside the file; position 0 of an empty file still returns an empty stream.
  - **BREAKING:** `isFileDenied` evaluates all deny rules first, and every configured allow-list must then pass. It denies `DANGEROUS_EXTENSIONS` by default (now also `html`, `htm`, `xhtml`, `shtml`, `mjs`, `hta`, `swf`, `xml`), and names ending in a dot or space. Comparisons ignore case. New optional `{ sniffedMimeType }` argument. Migration: allow needed types (for example `svg`) with `allowExtensions` or `allowDangerousExtensions`.
  - **Behaviour change:** Local and WebDAV public URLs percent-encode key segments, so the emitted URL changes for keys containing `%` or reserved characters (a key holding a literal `%7C` now yields `%257C`). ASCII keys without reserved characters are unchanged. `hydrateStorageUrls` rejects cycles and nesting over `maxDepth` (64).

  **ai**
  - **BREAKING (behaviour):** `MediaGenerationService` image/video generation makes one attempt by default (pass `maxAttempts` to retry). Kling/Runway/Stability errors carry HTTP `status` (`ProviderHttpError`), so 4xx and quota 429s are not retried. The DALL-E/OpenAI image SDKs use `maxRetries: 0`.
  - `getTaskStatus` records cost once when a task first completes (optional `{ userId, trackCost }`). Kling image and Replicate costs scale with output count. Kling/Runway report API error envelopes as FAILED and URL-encode task ids. **Behaviour change:** an unknown Kling/Runway task status is reported as FAILED instead of PROCESSING, so pollers stop on a status the adapter does not know.
  - **BREAKING (behaviour):** `AIModelCatalogService.updateModel` requires the API key to be re-entered when `provider`, `baseUrl`, `proxyHost` or `proxyPort` changes. New opt-in `requireHttpsBaseUrl`. `temperature` and `maxTokens` accept `null` to clear a stored value (range validation is unchanged). Migration: admin UIs must ask for the key again when these fields change.
  - **BREAKING (behaviour):** `AIConfigService` resolves explicit scenario mappings across all sources before any default, so a global `AI_MODEL` no longer hides a database mapping. A fallback taken after a source error is cached only for `setFallbackCacheTtl` (default 5 s, `0` disables) instead of the full TTL, so the failing source is retried soon without every call paying its timeout. A scoped env model with its own provider/base URL no longer inherits the global key: when a global key exists and `<PREFIX>_<SCENARIO>_API_KEY` is missing, the source throws a configuration error naming it. A scoped `PROVIDER` that differs from the global one no longer inherits the global `BASE_URL`. Database lookups are ordered by `id`, and their errors no longer expose ORM messages.
  - **BREAKING (behaviour):** `PromptManager.saveTemplate` surfaces database errors. With a database, the template cache is bounded (500 entries, 60 s TTL).
  - Cost aggregation keeps running statistics (no `RangeError` on large aggregates).
  - LangChain builders accept `provider` and refuse a non-OpenAI provider without `baseURL`. Without `provider` they still default to api.openai.com and log a one-time warning; `provider` will be required in the next minor.
  - Observer error text redacts credentials; provider streams are always closed; the remote config body is read inside its timeout; cached configs are returned as copies.

  **ai-access**
  - `PostgresCredentialProfileStore.runExclusive` runs queries on the locked connection, queues callers in the same process, and uses `pg_try_advisory_lock` with `lockTimeoutMs` (default 30 s). This fixes the pool deadlock. Codex refreshes are coalesced per store/profile and are not bound to one caller's abort signal; forced refreshes (after a 401) are coalesced separately from expiry checks, so they never receive the rejected token back.
  - New optional `credentialCodec { encrypt, decrypt }` encrypts stored OAuth credentials. Plaintext rows are still read and are re-encrypted on the next save.
  - Codex CLI host: `maxConcurrent` (default 4), stale-socket cleanup, owner-only socket. CLI stdout lines are capped at 16 MB.

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

- Updated dependencies
- Updated dependencies [5280170]
  - @zucker-framework/core@1.0.20

## 1.0.19

### Patch Changes

- @zucker-framework/core@1.0.19

## 1.0.18

### Patch Changes

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

- Allow applications to disable HTTP request-parameter and response-body capture across
  decorated controllers and all audit sinks, even when a controller opts in. Existing
  capture behavior is unchanged when these options are omitted. The Server template uses
  metadata-only durable HTTP audit records to keep private configuration and content out
  of independently authorized log views.
- Route public package-root imports and requires to the existing matching ESM/CJS runtime and type artifacts. Previously, native ESM imports of these packages fell back to their CommonJS main entry, mixing auth/core provider classes with an application's ESM instances and breaking Nest dependency injection. Keep package.json metadata readable and preserve the existing main/module artifacts.

  Add a native Node regression for both module formats that checks package resolution, shared auth/guard identity and an Admin/Nest composition using a synthetic memory adapter. This does not make mixed import/require copies of a dual package interchangeable and does not replace persistent consumer validation. No service implementation, guard registration or access policy is relaxed.

  Use the CommonJS default export for eventemitter2 in config, dictionary and logging, with an explicit injection token referencing the original constructor. This fixes native ESM loading while retaining the shared Nest event emitter; no dependency is bundled or duplicated.

- @zucker-framework/core@1.0.10

## 1.0.9

### Patch Changes

- Add optional HTTP completion observations and access/business persistence policies. Observe completed, rejected and aborted requests once, including streaming responses.
- Wait for bounded aggregate acknowledgement before access sampling; retain final HTTP failures and slow responses, and prevent duplicate rejection details. Existing configurations and persisted log schemas remain compatible.

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

- Expose producer prewarming/error callbacks and worker retry budgets/stalled interval; avoid removed BullMQ 6 paused-count argument while reading legacy paused counts without mutation. Validate worker options before opening connections. Harden persistent log pagination, date ranges and bounded CSV queries before storage access.
- Updated dependencies
  - @zucker-framework/core@1.0.5

## 1.0.3

### Patch Changes

- Preserve the original HTTP exception when ValidationPipe messages contain objects. Record only the exception summary instead of throwing during log redaction or serializing submitted values.

## 1.0.2

### Patch Changes

- c0de08f: Add response formatting/server-error hooks to the existing HTTP exception filter, configurable correlation header/request-property mapping, and error/slow-request observation hooks on the HTTP logger. Extend the existing ErrorTracker with bounded fixed-window retention, fingerprints, redaction and first-occurrence policy. Consumers can directly configure shared mechanisms without response-object shims, local request-ID middleware, duplicate error interceptors or timer-based deduplication services. Default Framework behavior remains compatible.

  Host configuration can assign 5xx stack logging to its exception filter while the shared interceptor handles observation and 4xx warnings. Reporting and observation callbacks do not replace the original exception/response when they fail.

- c0de08f: Add database-backed access and operation log services for paginated queries, statistics, timelines, bounded deletion, retention and CSV export. Root configuration reuses the host database adapter and explicitly configures privacy policy, client-IP retention and persistence. The shared interceptor persists both log kinds without changing application success/failure semantics and preserves structured HTTP error messages.
- c0de08f: Add persistent AI model administration with encrypted/masked credentials, transactional default reassignment and host validation/cache hooks. Add constrained catalog controller factories and nested prompt rendering. Add a shared Nest/Winston system-log sink with database draining and configurable PostgreSQL operational metrics. Product fields, permissions, privacy, recipients, templates and infrastructure settings remain consumer configuration.
- c0de08f: Add root-configured persistence for rejected HTTP requests, including guard failures and missing routes, with explicit path exclusions and client-IP retention policy. Add an HTTP error interceptor that preserves normalized request IDs and separates 4xx warnings from server-error stack logging without mutating its host logger context. Export the existing template HTML-escaping primitive for product templates to reuse directly.
- c0de08f: Expose API_KEY_GUARD_OPTIONS as an optional Nest injection token so guards discovered on routes receive the configured policy through imported modules.

  Route application log writes through the shared sink lifecycle. Stop accepting Winston writes before shutdown, drain accepted logs once, and preserve sanitized late shutdown diagnostics without writing to an ended stream.

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
