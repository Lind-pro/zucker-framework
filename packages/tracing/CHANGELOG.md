# @zucker-framework/tracing

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

- e7c1b6e: Bind HTTP retries and cookie-session restoration to the originating session. Add the
  optional HttpClientConfig.sessionKey callback and wire the admin consumer to its existing
  identity policy. Cookie clients without a stable key conservatively cancel ambiguous
  credential changes; retain request abort scopes for prompt cancellation.

  Release Observable subscriptions and tracing spans on completion, failure and cancellation.
  Dispose late network/datasource creations after lifecycle changes, roll back partially
  started rule triggers, bind provider disposables to their registration, stream local upload
  chunks with backpressure, preserve valid zero aggregations and cap all HybridCache L1 writes.

  Network shutdown now waits for pending provider operations; providers must bound their I/O.
  HybridCache L1 caps must be finite and non-negative; zero disables L1 population. Correct
  legacy test typing without changing runtime exports or weakening assertions.

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

- Updated dependencies
  - @zucker-framework/core@1.0.5

## 1.0.2

### Patch Changes

- Align all public Framework packages to the maintainer-selected 1.0.2 release and keep subsequent releases synchronized through a Changesets fixed group. Package dependencies and the CLI scaffold catalog follow the same version.

  This release consolidates the pending API migrations, including breaking auth and payment persistence contracts. Review docs/package-release-1.0.2.md before upgrading from 1.0.0 or 1.0.1.

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
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @zucker-framework/core@1.0.0
