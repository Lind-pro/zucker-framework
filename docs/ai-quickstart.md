# AI quickstart: image, video, music and chat

What a generated project ships, how to turn each part on, and how money flows. All paths are the
server's (`/api` prefix through Web's rewrite).

## 1. Turn on a provider

| Capability | Configure | Notes |
| --- | --- | --- |
| Chat | Any native connection: `AI_OPENAI_*`, `AI_COMPATIBLE_*`, `AI_OPENROUTER_*`, `AI_DEEPSEEK_*`, `AI_ANTHROPIC_*`, `AI_GEMINI_*` (`_ENABLED=true`, key, model id), or Admin "System > Connections" | With an empty chat catalog every enabled connection is offered. Reasoning (DeepSeek, Anthropic thinking, Gemini thoughts) is streamed separately and never billed as answer text. |
| Images | `AI_OPENAI_ENABLED=true` (provider id `ai-openai`, DALL-E images API) or a generic adapter | The default image catalog is `ai-openai` / `dall-e-3`. |
| Video, music, other images | `AI_MEDIA_ADAPTERS` (JSON array of `HttpAsyncTaskAdapterConfig`), `AI_MEDIA_<ID>_API_KEY`, optional `AI_MEDIA_<ID>_CALLBACK_SECRET` | Vendor neutral submit/poll mapping; see `packages/ai/README.md`, "Generic async media adapter". Music is experimental. |

Example adapter (one line in `.env`):

```
AI_MEDIA_ADAPTERS=[{"id":"acme-video","mediaType":"video","models":[{"id":"acme-v1","name":"Acme v1","mediaType":"video"}],"baseUrl":"https://api.acme.example","auth":{"type":"bearer"},"submit":{"path":"/v1/videos","fields":{"prompt":"prompt","duration":"seconds"},"taskIdPath":"id"},"poll":{"path":"/v1/videos/{taskId}","statusPath":"status","status":{"processing":["running"],"completed":["succeeded"],"failed":["failed"]},"outputPath":"outputs","outputItemUrlField":"url"},"callback":{"signatureHeader":"x-acme-signature","timestampHeader":"x-acme-timestamp","toleranceSeconds":300}}]
AI_MEDIA_ACME_VIDEO_API_KEY=...
AI_MEDIA_ACME_VIDEO_CALLBACK_SECRET=...
```

Invalid declarations stop the server at startup instead of silently dropping a provider. Provider
callbacks go to `POST /api/ai/tasks/callbacks/<id>`; an unverified callback can at most trigger one
early poll, never a state change.

## 2. Offer models and set prices (hot-applied policies)

Admin "AI > Models & pricing" (`config:update`) edits two product policies; changes apply within
about 30 seconds without a restart.

- `ai-catalog` (public): per kind (`image`, `video`, `audio`, `chat`) a list of
  `{ providerId, model, label? }`. Only listed models can be submitted (`400 AI_MODEL_NOT_OFFERED`).
  A listed model whose provider is not configured shows as unavailable (`503 AI_PROVIDER_UNAVAILABLE`).
- `ai-pricing`: media `{ default, byModel: { [model]: credits } }` per task, multiplied by `count`
  for images; chat `{ per1kInputTokens, per1kOutputTokens, minimum }`. `0` means free.

Pin a field from the environment to make it read-only in the admin, e.g.
`POLICY_AI_PRICING_IMAGE={"default":2,"byModel":{"dall-e-3":4}}` or
`POLICY_AI_CATALOG_CHAT=[{"providerId":"ai-deepseek","model":"deepseek-chat"}]`.

## 3. How credits move

- Media: `POST /api/ai/tasks` (Origin check, `Idempotency-Key`, limiter `ai-submit`) prices the task
  on the server, places a credit hold in the same transaction and returns `202`. The client may send
  the price it showed (`cost`); a different server price answers `409 AI_TASK_COST_CHANGED`. Success
  confirms the hold; failure, cancellation and timeout (`AI_TASKS_<KIND>_MAX_WAIT_MINUTES`) release it.
  Settlement happens exactly once.
- Chat: each message holds the largest affordable cost (bounded by `CHAT_MAX_OUTPUT_TOKENS`), streams,
  then releases the hold and consumes the actual token cost in one transaction. The balance never goes
  negative; an answer that runs out of credits is cut at what the user can afford.
- Outputs are copied into the owner's private storage (never served from the provider's URL),
  downloaded through short-lived tickets (`GET /api/ai/tasks/:id/outputs/:n`). One output may be up
  to `AI_OUTPUT_MAX_BYTES` (default 200 MiB; images at most 20 MiB) and is streamed to storage.
  Outputs count toward the owner's file quota (`FILES_OWNER_MAX_BYTES` / `_FILES`), checked under the
  owner's lock; a full quota fails the task (`AI_OUTPUT_QUOTA_EXCEEDED`) and releases the hold. With
  the S3 provider the object is still collected in memory before upload (no multipart yet).

## 4. User and staff screens

- Web: `/ai/image`, `/ai/video`, `/ai/music`, `/chat`, console `/account/tasks` and `/account/chats`.
  These pages need a session and are never cached by shared caches. The header balance refreshes
  after a charge (`zucker:credits-changed` browser event).
- API keys: an account key with the opt-in `ai:generate` scope may call `POST /api/v1/ai/tasks` and
  `GET /api/v1/ai/tasks/:id` (`X-API-Key`). Keys are created read-only unless the scope is requested.
- Admin: "AI > Generation tasks" (`ai-tasks:query`), "AI > AI chats" (`chats:query`, metadata only,
  no message text), "AI > Models & pricing". New installs get the menus from `pnpm account:admin`;
  databases seeded earlier get them from the `20261110060000_ai_back_office` migration.

## 5. Streaming chat through Web

`POST /api/chat/:id/messages` answers `text/event-stream` with events `start`, `reasoning`, `delta`,
`done` or `error`. The server sends `Cache-Control: private, no-store, no-transform` and
`X-Accel-Buffering: no` and flushes each event. `no-transform` matters: Next's built-in compression
(and other compressing proxies) otherwise gzip-buffers the stream and the browser sees every event at
once at the end. With it, Web's `/api` rewrite passes events through as they are written (verified
with a production `next start`). When a reverse proxy sits in front, also disable response buffering
for `/api/chat/` (nginx: `proxy_buffering off;`). Stopping a reply in the browser aborts the
request; the server stops the provider call and settles the message once (`ABORTED`).

## 6. Test without paid providers

- Unit/integration tests: `@zucker-framework/ai/testing` (`FakeChatModel`, `FakeMediaProvider`,
  `FakeCallbackVerifier`).
- Local end-to-end runs of the whole stack: `AI_TEST_FAKE_PROVIDERS=true` on the server swaps in those
  fakes (provider id `fake-media`, models `fake-image`, `fake-video`, `fake-audio`; chat still needs one
  enabled connection with dummy values, nothing is sent to it). The server refuses to start with this
  switch when `NODE_ENV=production`. Offer the fake models with
  `POLICY_AI_CATALOG_IMAGE=[{"providerId":"fake-media","model":"fake-image"}]`.
- Real-stack browser acceptance: start that server (migrated database, Redis optional) and a
  production Web build pointed at it, then `pnpm exec playwright test -c playwright.ai-stack.config.ts`
  (`E2E_STACK_WEB_URL`, default `http://127.0.0.1:4492`). It covers image submit → complete →
  download, incremental chat streaming through the rewrite, stop/abort settlement and the header
  balance. Sign-up there needs `POLICY_ACCOUNT_REQUIRE_EMAIL_VERIFICATION=false` and welcome credits.
