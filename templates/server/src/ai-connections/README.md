# Optional native AI connections

The server template owns connection configuration and assembly. `@zucker-framework/ai` continues to
own native protocols, retries, cancellation, streaming and usage normalization. This module adds no
AI HTTP call endpoint, prompt, product workflow or image/video protocol. All six connections are
disabled by default. Local validation constructs installed SDK clients; it never sends a model call
or verifies a remote account, model entitlement or account balance.

| Saved profile   | Explicit native route   | Environment prefix | Native protocol / SDK                   |
| --------------- | ----------------------- | ------------------ | --------------------------------------- |
| `ai-openai`     | `connection.openai`     | `AI_OPENAI`        | OpenAI / `openai`                       |
| `ai-compatible` | `connection.compatible` | `AI_COMPATIBLE`    | OpenAI-compatible / `openai`            |
| `ai-openrouter` | `connection.openrouter` | `AI_OPENROUTER`    | OpenRouter OpenAI-compatible / `openai` |
| `ai-deepseek`   | `connection.deepseek`   | `AI_DEEPSEEK`      | DeepSeek / `openai`                     |
| `ai-anthropic`  | `connection.anthropic`  | `AI_ANTHROPIC`     | Anthropic / `@anthropic-ai/sdk`         |
| `ai-gemini`     | `connection.gemini`     | `AI_GEMINI`        | Gemini / `@google/genai`                |

Each prefix accepts `_ENABLED`, `_API_KEY`, `_MODEL_ID`, `_BASE_URL`, `_MAX_TOKENS` and `_TIMEOUT_MS`.
An enabled connection requires its own explicit key and model ID. The compatible connection requires
an explicit HTTPS base URL; the named providers use their documented API endpoint unless overridden.
URLs cannot contain credentials, query strings or fragments. Anthropic also requires `MAX_TOKENS`.
The timeout defaults to 60,000 ms and accepts 1–600,000 ms. Maximum output tokens, when configured,
must be a positive integer no greater than 1,048,576; the chosen model may impose a smaller limit.
An unavailable SDK, missing required value or failed SDK construction makes an enabled connection
unavailable instead of selecting another provider.

## Composition and consumer routes

The composition root registers `ZuckerAIModule.forRootAsync` once with
`aiModuleOptionsFromEnvironment(RUNTIME_ENVIRONMENT)` and imports `AIConnectionsModule`. Feature
modules import `AIConnectionsModule` when they need its exported, injectable `NativeAIClient`.
The client uses the root `AIConfigService` and `AICallWrapper`, so retry/abort/observer ownership is
unchanged. `AI_NATIVE_MODEL_FACTORY` is an explicit replacement seam for synthetic tests or a
consumer-owned transport; production uses the existing `@zucker-framework/ai/native` factory.

Consumers declare their own business scenario names through the optional second argument:
`aiModuleOptionsFromEnvironment(environment, { routes })`, where `routes` maps each consumer-owned
scenario to one of the fixed routes above. Routes are declared in application code and are copied at
startup. Unknown connection targets and attempts to replace the reserved `connection.*` routes are
rejected. A declared route to a disabled connection still fails at lookup. The default routes map is
empty, and no model or business default is inferred.

The `runtime-connections` config source is terminal and has `failureMode: 'throw'`. A lookup for an
unknown route or disabled connection throws before `AIConfigService` can consult its automatically
appended legacy `DatabaseAIConfigSource`. This applies even when a caller allows defaults. The
public library's legacy behavior remains unchanged for other consumers. Do not register another
source to circumvent this template boundary; declare consumer scenario mappings in the options.
The older ProviderManager registry and general source inventory are metadata, not evidence that a
native connection or consumer scenario can run.

## Persistence, privacy and activation

Profiles use the existing runtime-settings encrypted CAS store, actor audit and trusted mutation
origin. API keys are secret fields with explicit keep/replace/clear operations, never response values.
No native connection fields are included in the public website integrations endpoint. Generic system
config remains separate. Saving performs local validation and records a candidate version only.
Every provider sees the frozen startup snapshot until the Server restarts; disabling a saved
connection takes effect on restart as well. A fresh config service then rejects disabled routes,
including previously cached consumer aliases.

There is no schema migration. Keep the dedicated `CONFIG_ENCRYPTION_KEY` with the saved profiles.
Rollback must account for older code that does not read these profiles. These tests use synthetic
credentials, real disposable PostgreSQL schemas, actual Nest composition, actual SDK construction
and substitute native model methods. No paid or remote model request is made.

Verification lives in `test/ai-connections.persistent.e2e-spec.ts`; the Admin dynamic form check is in
`test/connections.browser.e2e-spec.ts`. Model catalog discovery, provider billing, semantic output
quality and production credential validity are outside this local verification.
