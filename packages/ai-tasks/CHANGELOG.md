# @zucker-framework/ai-tasks

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

- Updated dependencies [f21f444]
- Updated dependencies [a8ca9ef]
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies [5280170]
- Updated dependencies [1696a82]
  - @zucker-framework/storage@1.0.20
  - @zucker-framework/ai@1.0.20
  - @zucker-framework/credit@1.0.20
  - @zucker-framework/task@1.0.20
  - @zucker-framework/core@1.0.20
