# @zucker-framework/storage

## 1.0.30

## 1.0.29

## 1.0.28

## 1.0.27

## 1.0.26

## 1.0.25

## 1.0.24

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

## 1.0.22

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

## 1.0.20

### Patch Changes

- f21f444: Account growth and security (phase 3): two-factor sign-in, role expiry, OAuth popups, promotions,
  streamed S3 uploads and the back-office pieces for them.

  **BREAKING (D19) — auth:** `@Permissions(['a', 'b'])` (an array) now throws a `TypeError` when the
  class is loaded; write `@Permissions('a', 'b')`. The array form was never enforced correctly: it
  stored `[['a','b']]` and every request failed the permission check. Same for
  `@Authorize({ permissions })` with nested arrays, blank or non-string codes. `@Permissions()` (any
  signed-in user) is unchanged. Consumers must grep for `@Permissions([` before upgrading.

  - auth: TOTP helpers (`generateTotpSecret`, `totpProvisioningUri`, recovery codes and hashing) and
    `TotpValidator.verifyOnce(userId, code, secret?)`. Verification is serialised per user, so concurrent
    submissions of one code accept it once and concurrent wrong guesses cannot all pass the lockout
    check; `TwoFactorStateStore.advanceCounter` (optional) is an atomic compare-and-set of the last used
    step for shared stores; `isLockedOut` / `recordFailedAttempt` let other factors (recovery codes)
    share the lockout. Opt-in role expiry: `ZuckerAuthModule.forRoot({ roleAssignments: { expiry: true } })`
    (requires `userRoles.expiresAt`); expired links grant nothing to permissions, role dimension, menus
    and hierarchy, and the permission cache never outlives the earliest expiry.
  - admin: `GET/PUT /users/:id/roles` carry per-role `expiries` when role expiry is on (400 otherwise).
  - fe-admin: two-factor step on the login page (`AdminTwoFactorRequiredError`, `loginTwoFactor`), role
    expiry dates in the role dialog, an optional "Reset 2FA" action (`users.twoFactorResetPath`), and the
    order ledger shows the amount charged, the discount and the list price.
  - fe-auth: `openOAuthPopup` / `claimOAuthPopup` (BroadcastChannel; `blocked` falls back to redirect).
  - fe-types: `PublicBillingCheckoutPolicy.promoCodes: 'none' | 'alias'`, `UserRoleExpiries`,
    `UserRolesResponse.expiries`.
  - payment: server-frozen promotions on hosted checkout (`HostedCheckoutOffer.promotion`,
    `checkoutPayable`, `snapshotPromotion`; provider subtotal, discount and reference are verified, and
    a discount on an order without a promotion fails). Codes that bring the total to zero are refused;
    subscriptions are discounted on the first invoice only (`initialMoney`). Stripe applies each
    promotion as a per-session, single-use, `once` coupon with the server-computed fixed `amount_off`
    (never a percentage), so Stripe's total always equals the frozen payable; the frozen provider code
    travels in session metadata (`zucker_promotion_code`, now a reserved metadata key) and is reported
    back as the discount reference. Without the `coupons` API on the client, promotions are refused.
    Stripe sessions with an empty `discounts` list report the reference as unknown (amounts are still
    verified). PayPal and Creem refuse promotions.
  - storage: `S3FileManager.uploadStream` uploads in multipart parts (`partSize`, default 8 MiB,
    5 MiB–5 GiB, one part in memory, aborted on failure) instead of buffering the whole object.

  Server, web and admin templates (copied by `zucker create`, not versioned): two-factor sign-in and
  setup with a local QR code, magic links (off by default), account deletion with a 7-day grace period
  and per-feature erase contributors, staff 2FA reset, in-app notifications, feedback, promotions,
  referrals (off by default), operations insights, streamed private-file downloads with an orphan
  sweeper, and a test-only fake payment provider (`BILLING_TEST_FAKE_PROVIDER`, refused in
  production). Migrations `20261111010000`…`20261111090000` are additive; the last adds indexes with
  plain `CREATE INDEX` (run during a quiet period on large tables). The Prisma schema now declares the
  billing refund relations and index names that the migrations already created, so
  `prisma migrate diff` is empty for the whole database.

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

### Patch Changes

- Route public package-root imports and requires to the existing matching ESM/CJS runtime and type artifacts. Previously, native ESM imports of these packages fell back to their CommonJS main entry, mixing auth/core provider classes with an application's ESM instances and breaking Nest dependency injection. Keep package.json metadata readable and preserve the existing main/module artifacts.

  Add a native Node regression for both module formats that checks package resolution, shared auth/guard identity and an Admin/Nest composition using a synthetic memory adapter. This does not make mixed import/require copies of a dual package interchangeable and does not replace persistent consumer validation. No service implementation, guard registration or access policy is relaxed.

  Use the CommonJS default export for eventemitter2 in config, dictionary and logging, with an explicit injection token referencing the original constructor. This fixes native ESM loading while retaining the shared Nest event emitter; no dependency is bundled or duplicated.

- Add private file asset orchestration over existing verified object transfers, with consumer-owned durable metadata and authorization ports. Reserve scoped idempotency and immutable content before uploading, verify content before readiness, and recover interrupted metadata commits without rewriting verified objects.

  Keep logical deletion separate from observed physical cleanup, retain tombstones, reject stale readiness commits, and make failed or late-arriving object cleanup retryable. Extend BufferedFileManagerStore with deletion. Database uniqueness/CAS and durable recovery scheduling remain explicit consumer integration requirements; no schema, production storage access or background worker is provisioned by the package.

  Propagate local filesystem permission/unknown errors instead of treating them as absence or successful deletion.

## 1.0.8

## 1.0.7

## 1.0.6

## 1.0.5

### Patch Changes

- Add cancellation deadline ref control, public synchronous/FIFO concurrency leases, non-mutating injectable-RNG shuffle, drain-on-error task mapping, immediate/configurable HTTP disconnect cancellation, and request-aggregate bounded Multer-compatible memory storage.

  Make WebDAV uploads/downloads truly streaming with cancellation/error teardown, directory stat rejection, shallow directory-inclusive listing, public ensureDirectory and explicit anonymous configuration policy. Correct FileManager's download stream type from fs.ReadStream to Node Readable (a breaking public type correction); upload accepts Readable. Hosts retain paths, ownership and disk recovery policy. Local/S3 buffering behavior is unchanged.

## 1.0.2

### Patch Changes

- c0de08f: Export UnavailableFileManager for explicitly disabled storage: writes and downloads reject, existence returns false and listing returns an empty array. Consumers provide their own localized configuration error. Enables direct FILE_MANAGER injection without a consumer forwarding service or duplicate lifecycle provider.
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

### Minor Changes

- Add private R2-compatible S3 configuration, separate permanent public URLs from short-lived download URLs, and make object listing complete across provider pagination and WebDAV subdirectories.

### Patch Changes

- Add Apache-2.0 license files, framework attribution, bundled third-party notices,
  and public npm publishing metadata to every library. Validate these materials
  in package contents before upload and declare required and optional runtime dependencies.
