# AI administration

`AIModelConfig.modelRecordId` carries the stable database configuration identity (distinct from a provider's `modelId`). `DatabaseAIConfigSource` preserves it through decryption and scenario caching so consumers can attribute usage without a later ambiguous model-name lookup. Other config sources may omit it; consumers must not fabricate persistent foreign keys for environment-only configurations. This additive API requires a new immutable AI release before registry consumers adopt it.

Existing `AIProvider.createModel` SDK-returning contracts remain available; the native text port below is additive. `AIModelCatalogService` adds persistent model administration with configured `DatabaseAdapter` and model name, an allowed provider list, encryption/decryption callbacks, optional product-field normalization and a cache-invalidation callback. The model table uses the existing name/provider/modelId/apiKey and enable/default/capability fields.

Ordinary list/detail/default reads mask credentials. Secret reads are explicit; consumers must apply a separate permission. Create/update validate before persistence, encrypt replacement keys, preserve an existing key on an empty edit, and keep thinking flags coherent. Default reassignment and the corresponding write share one database transaction; failed writes roll back the previous default. This transaction does not provide multi-writer singleton enforcement without a database constraint. Product scenario names, scenario overrides, routing and credential storage keys remain in the host. `testModelConnection` invokes a configured callback; absent a callback, it reports that connectivity has not been verified and never fabricates success or invokes a paid provider.

`PromptManager.render` uses the core template parser, supports own nested fields and preserves missing/null placeholders. Administrative writes can use `createCatalogAdminController` from the admin package with host-defined models, fields, relations and soft-delete policy. Existing prompt runtime cache/fallback APIs remain separate from persistent management writes.

Publish new package versions before registry-based consumers use these new exports. No schema migration or provider call is required by local administration integration.

## Optional LangChain observation

Import `LangChainCallObserver` from `@zucker-framework/ai/langchain` after installing `@langchain/core` and `zod`, the runtime peers of this opt-in entry. Configure success/error callbacks; the observer owns per-run timing and usage normalization, while the consumer owns metadata projections, sinks, cost tables and diagnostics. The main AI entry does not require the optional LangChain runtime. `createAbortScope` now exposes its controller alongside signal/dispose and preserves AI-specific cancellation/timeout errors.

## Optional LangChain execution

The `@zucker-framework/ai/langchain` entry also provides `createLangChainChatModel`, `createLangChainEmbeddingModel`, `collectLangChainText` and `executeLangChainStructured`. Install the optional LangChain SDKs used by the selected protocol; model construction imports SDKs lazily. The root AI entry does not load LangChain.

Model construction receives explicit credentials, model identifier, protocol, endpoint, timeout and supported thinking options. Chat outer retry count is required; embedding `maxRetries` defaults to zero. Inner SDK retries are zero to avoid multiplicative retry. Anthropic now preserves baseURL, timeout, fetch transport and explicit thinking `budgetTokens`. Gemini defaults point explicitly to Google's `/v1beta/openai` compatibility endpoint, not its native API. `thinking` is an explicit compatible-provider extension; its `reasoning_effort` is top-level. Native OpenAI reasoning uses `NativeChatRequest.reasoning` instead. SDK v7 no longer consumes `httpAgent`: `proxyUrl` requires an explicit proxy-aware `fetch`, otherwise construction fails before connecting. Provider discovery, scenario routing, caching and token budgets remain with the consumer.

`getLangChainProviderDefaults(provider)` supplies protocol, default endpoint and compatible structured-output method for OpenAI, DeepSeek, Gemini and Anthropic/Claude. Unknown providers use the OpenAI-compatible protocol with no default endpoint. Applications choose routes and retain explicit endpoint overrides; this lookup does not create a model or perform a request.

The root entry also exposes `classifyAICallOutcome(error)` for diagnostic `error/timeout/cancelled` records, including legacy message-based interruption errors. It does not change the existing `classifyAIError` retry decisions. Logging classification and retry policy must not be treated as interchangeable contracts.

Text collection separates reasoning from answer text and provides chunk/timing hooks. Structured execution sends the input schema for JSON mode, validates transforms/defaults, strips NUL characters, and optionally maps an array root to an explicitly supplied field. Parser errors can use one supplied repair callback; omitting it performs no additional provider call. Idle timeout and caller cancellation never enter parser recovery. The caller owns recovery prompts and budgets. Diagnostics are exposed through `StructuredOutputValidationError`, `StructuredOutputEmptyError` and structured failure metadata; local text parsing also exposes `StructuredOutputSyntaxError`.

`parseSchemaResponseText` and `validateStructuredOutput` are available at the root entry for consumers without LangChain. Text parsing uses direct/fenced JSON, one local syntax repair and strict schema validation, with no network operation. Import error classes from the same entry as the function that throws them.

The new execution source and independent mocked regression tests are present. Verification, lockfile synchronization and registry publication remain separate pending steps; no test or paid provider call was run for this source refactor.

`collectLangChainText` also accepts `{ model, messages, trim: false }` for complete LangChain histories (including image message blocks). This preserves whitespace and returns the last usage-bearing chunk as `usage`; it does not add usage chunks together. String content and text content blocks contribute answer text; other blocks are excluded. The prompt-based signature still trims text. An omitted idle timeout adds no deadline; callers with an existing budget continue passing it explicitly.

`collectGraphUpdates` consumes a graph's update iterator, awaits each node notification and optionally accumulates replacement fields from an initial state. It has no LangGraph runtime dependency and neither constructs nor retries a graph. The consumer passes its existing graph stream (including signal/configurable/metadata), retains topology and progress policy, and reads checkpoint/reducer state from its graph after completion. Iterator errors and notification failures propagate and close iteration. Multiple node updates in one event are all delivered.

## Strict routing and native text execution (unreleased)

`getScenarioConfig(scenario, { allowDefault: false })` requires explicit scenario mapping in every built-in source. Default and strict cache entries are isolated and both are invalidated by `invalidateScenario`. Environment sources require a scoped MODEL/MODEL_ID but may inherit shared credentials. Remote sources send `?allowDefault=false` and require the unwrapped payload's `scenario` to equal the requested scenario (including custom transforms); older servers cannot silently downgrade strict requests. Custom `AIConfigSource` implementations must honor the same options. Product scenario names remain consumer policy.

The root exports `NativeAIClient`, `NativeAIModel`, `NativeModelFactory`, and request/result types. SDK-specific `createNativeAIModel` and `openAINativeModel`/`anthropicNativeModel`/`geminiNativeModel` adapters are exported by `@zucker-framework/ai/native`. `NativeAIClient(configService, callWrapper, optionalFactory)` resolves configuration and provides `chat`, aggregated `stream`, and `embed`. Embedding always resolves strictly **before constructing a provider**, validates dimensions/indexes/finite values, and never picks a model. Results carry only `{modelId, providerId, modelRecordId}` as `config`, never credentials. Usage is normalized to input/output/total; absent usage remains absent. Consumers record cost once after success, using the resolved record ID, not a name lookup.

The default factory lazily loads actual OpenAI/DeepSeek (`openai`), Anthropic/Claude (`@anthropic-ai/sdk`), or Gemini (`@google/genai`) SDKs. Native Gemini is not coerced to OpenAI. SDK retries are disabled; `AICallWrapper` owns retry/deadline/cancellation and streams are never replayed. Anthropic cached input and Gemini thought tokens are included in totals; Gemini embedding usage is omitted because that response does not guarantee token counts. Anthropic has no embedding port. No model IDs, prompts, price tables or product schema are supplied by the library.

Native and LangChain calls to official OpenAI Chat Completions share parameter normalization. The configured `maxTokens` becomes `max_completion_tokens` independently of reasoning, and GPT-6 sampling parameters are omitted unless reasoning is explicitly `none`. Other endpoints retain their existing parameter contract.

The built-in port is **text-only**: callers needing image/tool conversations must use an explicitly capable port or the existing opt-in LangChain interface. JSON-object requests use OpenAI JSON mode, Gemini JSON MIME, or a forced Anthropic `json_output` tool. Native reasoning accepts OpenAI effort or Anthropic/Gemini token budgets; unsupported combinations reject rather than silently discard settings. Anthropic requires configured maxTokens. For OpenAI/Anthropic proxy use, pass a proxy-aware fetch to `createNativeAIModel`; native Gemini's installed SDK lacks public fetch injection, so proxy callers must supply their own `NativeModelFactory`. Configured proxies never silently fall back to direct connections.

`PersistedCostTracker` now snapshots/single-flights flush, preserves entries arriving during persistence, separates provider/record identity and warns about missing IDs even in mixed batches. Persist failures restore the snapshot and reject; scheduled callers must observe errors and arrange retry. This is not a durable exactly-once ledger: ambiguous partial DB commits require an idempotent transactional `CostPersister`. No table or uniqueness policy is imposed by this package.

Local tests include real SDKs against synthetic loopback HTTP/SSE and fake persistence. They do not establish real provider/proxy/database health. Publish a new immutable package before production integration.

### Provider model discovery (experimental)

`listProviderModels({ provider, apiKey, baseUrl?, proxyHost?, proxyPort? })` returns
`{ id, name }[]` from an account-visible provider catalogue. OpenAI, DeepSeek and
Custom use the OpenAI-compatible `/models` protocol; Claude uses Anthropic model
pagination; Gemini uses its native list API (or OpenAI compatibility when the
configured base ends in `/openai`). A custom provider requires an explicit base.
The request uses a 20-second overall deadline, bounded response size/pagination,
and never follows credential-bearing redirects. No inference is performed.

`AIModelCatalogService.getAvailableModels(id)` uses its configured database and
secret decryptor and returns only catalogue entries. Consumers own authorization,
provider selection, and any restrictions on allowed destinations. In particular,
never forward a hidden saved credential to an unconfirmed endpoint override.
Lists do not establish pricing, task suitability, or inference permissions.

A second consumer can use this API for a document summarization console with its
own database adapter and encryption, without importing product schemas or routes.
These new exports are experimental until their catalogue contract stabilizes.

## Native SDK adapter entry

Import the provider-neutral `NativeAIClient` and port types from `@zucker-framework/ai`. The root declaration graph does not require optional Anthropic/Gemini SDK types. Import SDK-specific factories (`createNativeAIModel`, `openAINativeModel`, `anthropicNativeModel`, `geminiNativeModel`) and `NativeTransportOptions` from `@zucker-framework/ai/native`; this opt-in entry requires the declared OpenAI, Anthropic and Google GenAI peers. No root compatibility re-export is provided. Actual SDK requests are still created only when the selected provider is invoked.

### Incremental LangChain answer text

`collectLangChainText({ ..., onTextDelta })` delivers each non-empty answer delta before collection completes. Both string content and text content blocks are supported; reasoning and non-text blocks are excluded. Async callbacks are awaited in order. A callback failure propagates and aborts the provider stream, allowing the consumer to enforce durable-write failure semantics without copying the stream collector.

The returned `finishReason` is the last explicit `finish_reason` or `stop_reason` from streamed message metadata. It remains absent when the provider did not supply one. Consumers that require completion must check this value; background logging observers are not an authoritative completion signal.

`collectGraphUpdates` invokes `onNodeComplete(node, update)` with the actual node update before reading the next graph event. Use this payload for immediate progress; checkpoint storage may not yet expose it. The collector does not interpret graph reducers or take over checkpoint persistence. The second argument is optional for empty updates, and existing callbacks accepting only `node` continue to work.

## Generic async media adapter (`HttpAsyncTaskMediaProvider`)

For video/music/image vendors whose API is "submit a job, then poll it", declare the mapping instead
of writing a provider class. The adapter is vendor neutral and fails closed:

```ts
import { HttpAsyncTaskMediaProvider, MediaType } from '@zucker-framework/ai';

const provider = new HttpAsyncTaskMediaProvider({
  id: 'acme-video', mediaType: MediaType.VIDEO,
  models: [{ id: 'acme-v1', name: 'Acme v1', mediaType: MediaType.VIDEO }],
  baseUrl: 'https://api.acme.example',          // https only; no credentials, IP literals or localhost
  auth: { type: 'bearer' },                      // or { type: 'header', name: 'x-api-key' } / { type: 'none' }
  submit: { path: '/v1/videos', fields: { prompt: 'input.prompt', duration: 'input.seconds', callbackUrl: 'webhook' },
            taskIdPath: 'data.id' },
  poll: { path: '/v1/videos/{taskId}', statusPath: 'data.status',
          status: { pending: ['queued'], processing: ['running'], completed: ['succeeded'], failed: ['failed'] },
          outputPath: 'data.outputs', outputItemUrlField: 'url', progressPath: 'data.progress', progressScale: 100,
          errorPath: 'data.error.message' },
});
```

- Requests go through core's `createPublicFetch` (DNS-pinned public addresses, port 443 unless
  `allowedPorts`, no redirects) and are locked to the `baseUrl` host; responses are capped at
  `maxResponseBytes` (1 MiB). Unknown statuses count as failed; output URLs must be https.
- Task ids are printable ASCII up to 256 characters and never `.` or `..`, so they cannot climb out of
  the poll path.
- `createCallbackVerifier({ secret, signatureHeader, timestampHeader?, toleranceSeconds?, ... })`
  returns an `AIProviderCallbackVerifier` (HMAC SHA-256/512, hex/base64). `verify()` returns `null`
  for anything unauthenticated and never throws; treat a verified callback as a wake-up hint and
  settle idempotently (replays happen). `hint()` may name a task to poll early, never to change state.

The server template reads these declarations from `AI_MEDIA_ADAPTERS` (JSON array) with
`AI_MEDIA_<ID>_API_KEY` and `AI_MEDIA_<ID>_CALLBACK_SECRET`; see `docs/ai-quickstart.md`.

## Test doubles (`@zucker-framework/ai/testing`)

Deterministic fakes for consumers' unit and end-to-end tests. They import no optional SDK peer and
never touch the network.

- `FakeChatModel` implements `NativeAIModel`. Pass `fake.factory` as the model factory:
  `new NativeAIClient(configs, calls, fake.factory)`. Script replies with `enqueue({ content, chunks,
  reasoning, usage, delayMs, error, failAfterChunks })` or `defaultStep`; streams yield an optional
  reasoning chunk, the content chunks (each after `delayMs`) and one usage chunk; abort ends the stream
  with the signal's reason. `calls` records requests (never the API key).
- `FakeMediaProvider` implements image/video/audio generation (`AudioGenerationProvider`). Steps choose
  `sync`/`async`, `pollsUntilDone`, `outputs`, `outputKind` (`base64` or `url`), `cost`, failures
  (`outcome: 'failure'`, `throwStatus`, `submitStatus`).
- `FakeCallbackVerifier` accepts a request whose `x-fake-signature` header equals its token and whose
  body is `{"taskId": "..."}`; it never returns a task, so callers must poll.
- `reset()` on the chat and media fakes drops unconsumed steps and recorded calls so one instance can
  be reused across tests. `fakeTokenCount(text)` (`ceil(length / 4)`) and `FAKE_PNG_BASE64` help
  compute expectations.
