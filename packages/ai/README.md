# AI administration

The package's model/provider execution contracts are unchanged. `AIModelCatalogService` adds persistent model administration with configured `DatabaseAdapter` and model name, an allowed provider list, encryption/decryption callbacks, optional product-field normalization and a cache-invalidation callback. The model table uses the existing name/provider/modelId/apiKey and enable/default/capability fields.

Ordinary list/detail/default reads mask credentials. Secret reads are explicit; consumers must apply a separate permission. Create/update validate before persistence, encrypt replacement keys, preserve an existing key on an empty edit, and keep thinking flags coherent. Default reassignment and the corresponding write share one database transaction; failed writes roll back the previous default. This transaction does not provide multi-writer singleton enforcement without a database constraint. Product scenario names, scenario overrides, routing and credential storage keys remain in the host. `testModelConnection` invokes a configured callback; absent a callback, it reports that connectivity has not been verified and never fabricates success or invokes a paid provider.

`PromptManager.render` uses the core template parser, supports own nested fields and preserves missing/null placeholders. Administrative writes can use `createCatalogAdminController` from the admin package with host-defined models, fields, relations and soft-delete policy. Existing prompt runtime cache/fallback APIs remain separate from persistent management writes.

Publish new package versions before registry-based consumers use these new exports. No schema migration or provider call is required by local administration integration.

## Optional LangChain observation

Import `LangChainCallObserver` from `@zucker-framework/ai/langchain` after installing `@langchain/core` and `zod`, the runtime peers of this opt-in entry. Configure success/error callbacks; the observer owns per-run timing and usage normalization, while the consumer owns metadata projections, sinks, cost tables and diagnostics. The main AI entry does not require the optional LangChain runtime. `createAbortScope` now exposes its controller alongside signal/dispose and preserves AI-specific cancellation/timeout errors.

## Optional LangChain execution

The `@zucker-framework/ai/langchain` entry also provides `createLangChainChatModel`, `createLangChainEmbeddingModel`, `collectLangChainText` and `executeLangChainStructured`. Install the optional LangChain SDKs used by the selected protocol; model construction imports SDKs and the optional proxy agent lazily. The root AI entry does not load LangChain.

Model construction receives explicit credentials, model identifier, protocol, endpoint, timeout and supported thinking options. Chat SDK retry count is required and comes from the caller; embedding construction retains SDK defaults. The Anthropic branch currently applies model, credentials, temperature, token limit and retries, without adding extended-thinking support. Provider discovery, scenario routing, caching and token budgets remain with the consumer.

`getLangChainProviderDefaults(provider)` supplies protocol, default endpoint and compatible structured-output method for OpenAI, DeepSeek, Gemini and Anthropic/Claude. Unknown providers use the OpenAI-compatible protocol with no default endpoint. Applications choose routes and retain explicit endpoint overrides; this lookup does not create a model or perform a request.

The root entry also exposes `classifyAICallOutcome(error)` for diagnostic `error/timeout/cancelled` records, including legacy message-based interruption errors. It does not change the existing `classifyAIError` retry decisions. Logging classification and retry policy must not be treated as interchangeable contracts.

Text collection separates reasoning from answer text and provides chunk/timing hooks. Structured execution sends the input schema for JSON mode, validates transforms/defaults, strips NUL characters, and optionally maps an array root to an explicitly supplied field. Parser errors can use one supplied repair callback; omitting it performs no additional provider call. Idle timeout and caller cancellation never enter parser recovery. The caller owns recovery prompts and budgets. Diagnostics are exposed through `StructuredOutputValidationError`, `StructuredOutputEmptyError` and structured failure metadata; local text parsing also exposes `StructuredOutputSyntaxError`.

`parseSchemaResponseText` and `validateStructuredOutput` are available at the root entry for consumers without LangChain. Text parsing uses direct/fenced JSON, one local syntax repair and strict schema validation, with no network operation. Import error classes from the same entry as the function that throws them.

The new execution source and independent mocked regression tests are present. Verification, lockfile synchronization and registry publication remain separate pending steps; no test or paid provider call was run for this source refactor.

`collectLangChainText` also accepts `{ model, messages, trim: false }` for complete LangChain histories (including image message blocks). This preserves whitespace and returns the last usage-bearing chunk as `usage`; it does not add usage chunks together or extract non-string answer blocks. The prompt-based signature still trims text. An omitted idle timeout adds no deadline; callers with an existing budget continue passing it explicitly.

`collectGraphUpdates` consumes a graph's update iterator, awaits each node notification and optionally accumulates replacement fields from an initial state. It has no LangGraph runtime dependency and neither constructs nor retries a graph. The consumer passes its existing graph stream (including signal/configurable/metadata), retains topology and progress policy, and reads checkpoint/reducer state from its graph after completion. Iterator errors and notification failures propagate and close iteration. Multiple node updates in one event are all delivered.
