# @zucker-framework/ai

## 1.0.28

### Patch Changes

- @zucker-framework/ai-access@1.0.28
  - @zucker-framework/common@1.0.28
  - @zucker-framework/core@1.0.28

## 1.0.27

### Patch Changes

- Updated dependencies [2abf135]
  - @zucker-framework/ai-access@1.0.27
  - @zucker-framework/common@1.0.27
  - @zucker-framework/core@1.0.27

## 1.0.26

### Patch Changes

- @zucker-framework/ai-access@1.0.26
  - @zucker-framework/common@1.0.26
  - @zucker-framework/core@1.0.26

## 1.0.25

### Patch Changes

- @zucker-framework/ai-access@1.0.25
  - @zucker-framework/common@1.0.25
  - @zucker-framework/core@1.0.25

## 1.0.24

### Patch Changes

- Updated dependencies [d727e57]
  - @zucker-framework/ai-access@1.0.24
  - @zucker-framework/common@1.0.24
  - @zucker-framework/core@1.0.24

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

- Updated dependencies
  - @zucker-framework/ai-access@1.0.23
  - @zucker-framework/common@1.0.23
  - @zucker-framework/core@1.0.23

## 1.0.22

### Patch Changes

- Updated dependencies
  - @zucker-framework/ai-access@1.0.22
  - @zucker-framework/common@1.0.22
  - @zucker-framework/core@1.0.22

## 1.0.21

### Patch Changes

- Updated dependencies [305f24b]
  - @zucker-framework/common@1.0.21
  - @zucker-framework/ai-access@1.0.21
  - @zucker-framework/core@1.0.21

## 1.0.20

### Patch Changes

- a8ca9ef: AI product layer (phase 2): metered image/video/music generation tasks, streaming chat with history,
  public site images and the back-office pages for them.

  - ai-tasks (new): `AITaskService` runs durable, credit-metered media generation on the
    `@zucker-framework/task` runtime: idempotent submit with a credit hold, short poll runs that hold no
    worker slot while the provider works, verified provider callbacks as wake-up hints, cancellation,
    deadlines, outputs streamed into private storage (own size cap, type sniffed and hashed while
    streaming; the template counts them toward the owner's file quota) and exactly-once hold
    settlement. Lock order is `async_jobs` before `ai_tasks` in every transaction. `./adapters` maps the
    credit ledger and storage onto its ports. Schema in `assets/ai-tasks.{prisma,postgresql.sql}`.
  - ai: vendor-neutral `HttpAsyncTaskMediaProvider` (JSON-declared submit/poll adapter, https only,
    host-locked, SSRF-safe fetch, HMAC callback verifier); `AIProviderCallbackVerifier` contract;
    `AudioGenerationProvider`; `MediaTaskResult.outputs`; streamed `reasoning` chunks (DeepSeek,
    Anthropic, Gemini) and an awaited `onChunk` option on `NativeAIClient.stream`. New
    `@zucker-framework/ai/testing` subpath: `FakeChatModel`, `FakeMediaProvider`,
    `FakeCallbackVerifier` (scriptable, `reset()`), for consumers' tests without paid calls.
  - fe-http-client: a refused `fetchStream` error now carries the JSON body's `code` and
    `response.data` (like axios errors), so callers can map server error codes, not only the status.
  - storage: `PublicAssetService` for content-addressed, re-encoded public images (PNG/JPEG/WebP,
    SVG rejected).
  - rate-limiter: a request is charged at most once per limiter even when `RateLimitGuard` runs twice
    (global guard plus `@UseGuards`, or class plus handler). The global guard now defers to routes that
    list `RateLimitGuard` themselves (`GlobalRateLimitGuard`). Previously such routes spent two points
    per request, so a limit of N admitted N/2.

  Server template (copied by `zucker create` / `zucker init`, not versioned): `/api/ai/catalog`,
  `/api/ai/tasks*` (Idempotency-Key, Origin check, `ai-submit` limiter), `/api/v1/ai/tasks*` for API
  keys with the new opt-in `ai:generate` scope, `/api/ai/tasks/callbacks/:provider`, `/api/chat*` with
  SSE streaming (`Cache-Control: private, no-store, no-transform`, so compressing proxies such as
  Next's do not buffer it) and per-message settlement, `/api/management/{ai-tasks,chats}` (`ai-tasks:query`,
  `chats:query`), hot-applied `ai-pricing` / `ai-catalog` policies, public assets
  (`/api/public-assets/*`, admin upload). Env: `AI_MEDIA_ADAPTERS`, `AI_TASKS_*_MAX_WAIT_MINUTES`,
  `AI_OUTPUT_MAX_BYTES`, `CHAT_MAX_OUTPUT_TOKENS`, `PUBLIC_ASSETS_MAX_BYTES`, `PUBLIC_ASSETS_BASE_URL`.
  Files above `FILES_MAX_BYTES` download through the ticket route as a stream. `AI_TEST_FAKE_PROVIDERS`
  is a test-only switch (refused in production). Run `prisma migrate deploy`: the migrations are additive (public assets, AI tasks and chat, AI
  back-office permissions and menus for already-seeded databases).

  Web template: AI studio (`/ai/image`, `/ai/video`, `/ai/music`), chat (`/chat`), console pages
  `/account/tasks` and `/account/chats`, header balance refreshes after a charge; `/ai` and `/chat` are
  session-gated and never shared-cached; per-account pages mount only after the session hydrates.
  Default navigation gains AI studio and Chat links. Admin template: AI tasks, AI chats, Models & pricing pages and
  upload buttons for site images and the logo.

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
- Updated dependencies
- Updated dependencies [5280170]
  - @zucker-framework/ai-access@1.0.20
  - @zucker-framework/common@1.0.20
  - @zucker-framework/core@1.0.20

## 1.0.19

### Patch Changes

- Apply the existing official OpenAI Chat Completions parameter normalization to native SDK chat and stream calls. Use max_completion_tokens independently of reasoning, remove unsupported GPT-6 sampling parameters, and share the normalization with LangChain while preserving compatible-provider requests and configured transport behavior.
- @zucker-framework/ai-access@1.0.19
  - @zucker-framework/common@1.0.19
  - @zucker-framework/core@1.0.19

## 1.0.18

### Patch Changes

- Updated dependencies
  - @zucker-framework/common@1.0.18
  - @zucker-framework/ai-access@1.0.18
  - @zucker-framework/core@1.0.18

## 1.0.17

### Patch Changes

- @zucker-framework/ai-access@1.0.17
  - @zucker-framework/common@1.0.17
  - @zucker-framework/core@1.0.17

## 1.0.16

### Patch Changes

- @zucker-framework/ai-access@1.0.16
  - @zucker-framework/common@1.0.16
  - @zucker-framework/core@1.0.16

## 1.0.15

### Patch Changes

- @zucker-framework/ai-access@1.0.15
  - @zucker-framework/common@1.0.15
  - @zucker-framework/core@1.0.15

## 1.0.14

### Patch Changes

- Normalize official OpenAI Chat Completions token limits to max_completion_tokens and omit unsupported GPT-6 reasoning sampling parameters. Preserve compatible-provider requests, injected transports, cancellation, and retry policy across streamed and structured LangChain calls.
- @zucker-framework/ai-access@1.0.14
  - @zucker-framework/common@1.0.14
  - @zucker-framework/core@1.0.14

## 1.0.13

### Patch Changes

- Updated dependencies
  - @zucker-framework/ai-access@1.0.13
  - @zucker-framework/common@1.0.13
  - @zucker-framework/core@1.0.13

## 1.0.12

### Patch Changes

- @zucker-framework/ai-access@1.0.12
  - @zucker-framework/common@1.0.12
  - @zucker-framework/core@1.0.12

## 1.0.11

### Patch Changes

- Advertise Gemini image generation's single-attempt capability and map maxRetries: 0 to one SDK
  attempt without changing ordinary retry defaults. Preserve complete provider usage, request and
  model metadata, including candidate/reasoning totals and reported modality counts. Missing usage
  remains unknown, and unsupported retry values reject before provider dispatch.
- @zucker-framework/ai-access@1.0.11
  - @zucker-framework/common@1.0.11
  - @zucker-framework/core@1.0.11

## 1.0.10

### Patch Changes

- Updated dependencies
  - @zucker-framework/common@1.0.10
  - @zucker-framework/ai-access@1.0.10
  - @zucker-framework/core@1.0.10

## 1.0.9

### Patch Changes

- Add optional source-image editing through `ImageProvider.editImage` and export `ImageProviderSource`. OpenAI sends ordered PNG, JPEG or WebP uploads through the SDK multipart edit endpoint, preserves the configured model ID, and rejects invalid sources before dispatch. Unsupported or failed edits never fall back to text-only generation.

- Expose `supportsSingleAttempt`, `maxRetries: 0`, and typed `ImageProviderUsage`. The OpenAI image adapter disables SDK retries on request and preserves cancellation, request metadata, and reported token categories for both generation and editing. Gemini behavior is unchanged in this scoped release.

## 1.0.8

### Patch Changes

- Preserve cancellation requested by the final streamed-answer callback instead of returning a completed result.

- Expose awaited answer-only onTextDelta callbacks on LangChain collection and AI access requests. Codex CLI streaming uses an isolated ephemeral app-server turn with real answer deltas, cancellation, failure propagation, and completed-usage validation; non-streaming exec calls retain their existing behavior.

  Pass each graph node's current update as an optional second onNodeComplete argument. Consumers can publish completed-node results immediately without depending on durable checkpoint write visibility; existing one-argument callbacks remain compatible.

- Updated dependencies [3aed934]
- Updated dependencies
  - @zucker-framework/ai-access@1.0.8
  - @zucker-framework/common@1.0.8
  - @zucker-framework/core@1.0.8

## 1.0.7

### Patch Changes

- @zucker-framework/ai-access@1.0.7
  - @zucker-framework/common@1.0.7
  - @zucker-framework/core@1.0.7

## 1.0.6

### Patch Changes

- @zucker-framework/ai-access@1.0.6
  - @zucker-framework/common@1.0.6
  - @zucker-framework/core@1.0.6

## 1.0.5

### Patch Changes

- Add strict scenario resolution across configuration sources and isolated caches, preserve resolved model record identity, and expose a provider-neutral native text chat/stream/embedding port with actual OpenAI, Anthropic and Gemini SDK adapters. Disable SDK retry multiplication, retain abort/usage semantics, and reject unsupported proxy/reasoning combinations explicitly.

  Correct LangChain Gemini compatibility endpoint and Anthropic transport/thinking configuration. Proxy transport now requires explicit proxy-aware fetch (SDK v7 no longer supports httpAgent). Embedding outer retries default to zero.

  Snapshot and serialize persisted usage flushes to avoid lost new records or duplicate concurrent flushes. Failed persistence restores aggregates and now rejects; callers must observe failures and schedule retries. Ambiguous partial writes still require an idempotent consumer persister. Missing model IDs are observably skipped, including mixed batches.

- Updated dependencies
  - @zucker-framework/core@1.0.5
  - @zucker-framework/common@1.0.5
  - @zucker-framework/ai-access@1.0.5

## 1.0.3

### Patch Changes

- Add experimental provider model discovery for OpenAI-compatible, Anthropic and Gemini catalogues, including configured proxies, bounded pagination and credential-safe failures. Expose saved-credential discovery through AIModelCatalogService without returning secrets.

## 1.0.2

### Patch Changes

- c0de08f: Add explicit LangChain chat/embedding construction, text stream collection, structured execution and strict schema postprocessing through public AI entry points. Keep provider routing, chat retry count, recovery prompts/budgets and optional array-root mapping caller-controlled. SDKs remain lazy; idle/cancel failures bypass parser recovery.

  Add a lazy coalesced AI access client session with one provider attempt per explicit invocation and awaited outcome observers. Failed initialization can recover on a later request without automatically retrying provider work.

- c0de08f: Expose LangChain provider protocol/endpoint/structured-output defaults through the existing optional LangChain entry. Unknown providers retain the OpenAI-compatible protocol without an assumed endpoint; callers keep explicit endpoint overrides and model/routing policy.

  Expose a diagnostic failure-outcome classifier for cancellation, timeout and other errors. Keep the existing retry classifier unchanged so moving observation logic does not silently alter provider attempts.

  Consumer source integration and regression sources are prepared. Tests, dependency synchronization and immutable publication remain pending.

- c0de08f: Add graph update consumption to the public AI LangChain entry and support full message histories, reply whitespace policy and usage metadata in its text collector. Existing prompt callers retain trimmed output.

  Add a single-execution heartbeat scope with serial heartbeats, typed heartbeat failure, caller cancellation forwarding and cleanup. It has no lease, worker or persistence policy.

  Add subscription-based SSE with serialized asynchronous transforms, terminal delivery, snapshot and disconnect cleanup. Disconnecting this stream never cancels the producer.

- c0de08f: Add persistent AI model administration with encrypted/masked credentials, transactional default reassignment and host validation/cache hooks. Add constrained catalog controller factories and nested prompt rendering. Add a shared Nest/Winston system-log sink with database draining and configurable PostgreSQL operational metrics. Product fields, permissions, privacy, recipients, templates and infrastructure settings remain consumer configuration.
- Align all public Framework packages to the maintainer-selected 1.0.2 release and keep subsequent releases synchronized through a Changesets fixed group. Package dependencies and the CLI scaffold catalog follow the same version.

  This release consolidates the pending API migrations, including breaking auth and payment persistence contracts. Review docs/package-release-1.0.2.md before upgrading from 1.0.0 or 1.0.1.

- c0de08f: Extract consumer-independent cancellation scopes, per-chunk idle timeouts, bounded concurrency admission and timezone helpers; reuse cancellation in the AI adapter. Add signed browser-bound OAuth state, login audit with transactional counters, device parsing and configurable Passport guards. Authorization guards can deny provider errors and select a safe log identity without rewriting request.user.

  Add a validated HTTP query DTO without changing QueryParamEntity. MetadataLogService reuses log persistence for explicitly projected metadata. The optional ai/langchain entry captures call timing and usage without forcing LangChain on other AI consumers.

  Add the single-process task supervisor and temporary export artifact manager. Both preserve their process-local scheduling boundaries: neither introduces durable task storage, distributed leases or multi-executor safety. Consumers retain state transitions, ownership, retry eligibility, prompts, budgets, messages, retention schedules and output policy.

  Source migration only: new APIs, independent test sources and consumers are prepared; verification and immutable publication remain separate pending stages.

  Add durable recipient inbox operations and bounded verified object transfer; retain recipient constraints in updates, reject content collisions, keep dry runs read-only and verify uploaded object bytes before success.

- Updated dependencies [c0de08f]
- Updated dependencies [c0de08f]
- Updated dependencies [3a5d2e2]
- Updated dependencies [c0de08f]
- Updated dependencies [c0de08f]
- Updated dependencies [c0de08f]
- Updated dependencies [c0de08f]
- Updated dependencies [c0de08f]
- Updated dependencies [c0de08f]
- Updated dependencies [c0de08f]
- Updated dependencies
- Updated dependencies [c0de08f]
  - @zucker-framework/ai-access@1.0.2
  - @zucker-framework/common@1.0.2
  - @zucker-framework/core@1.0.2

## 1.0.0

### Major Changes

- First stable public release under the @zucker-framework organization. Publish compiled JavaScript, public type declarations, required runtime assets and Apache-2.0 license materials without source maps.

### Minor Changes

- Add a trusted-automation Codex subscription provider with an official `codex exec` driver, ephemeral structured runs, least-privilege permission profiles, isolated child environments, cancellation and timeout handling. Keep the direct ChatGPT Responses transport as an explicitly experimental compatibility path.
- Add priority-ordered AI configuration sources for environment values, remote APIs, databases, and static configuration while preserving the existing database adapter fallback.

### Patch Changes

- Add Apache-2.0 license files, framework attribution, bundled third-party notices,
  and public npm publishing metadata to every library. Validate these materials
  in package contents before upload and declare required and optional runtime dependencies.
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @zucker-framework/ai-access@1.0.0
  - @zucker-framework/core@1.0.0
