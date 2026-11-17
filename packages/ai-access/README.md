# AI access

This package owns provider access contracts, credential ownership and runtime adapters, including the external-readonly Codex CLI subscription provider. Applications select configured providers and models, decide routing/fallback, and map business context into their own logs. Provider credentials and auth profiles remain in their configured owner; client sessions do not copy or alter them.

## Observed client sessions

`AIAccessClientSession` accepts an asynchronous `AIAccessClient` factory. Concurrent first requests share one lazy initialization; a failed initialization is cleared so a later explicit request can initialize again. Each `complete` call makes exactly one provider attempt and awaits optional success/failure observers with its start timestamp. There is no automatic provider retry, fallback route, scheduled work or credential policy in the session.

```ts
import { AIAccessClientSession } from '@zucker-framework/ai-access';

const session = new AIAccessClientSession(async () => configuredClient);
const result = await session.complete(request, {
  onSuccess: (result, startedAt) => recordSuccess(result, startedAt),
  onFailure: (error, startedAt) => recordFailure(error, startedAt),
});
```

`configuredClient`, `request` and the observation callbacks above are supplied by the application. Observer failures propagate; an observer must not report a provider outcome that it did not observe. Output-schema parsing and postprocessing are separate AI package capabilities.

## Live answer text

Pass `request.onTextDelta` to receive answer text as it arrives. The callback may be asynchronous: calls are ordered and awaited, and a callback failure stops the attempt. Reasoning is excluded. Success still requires a completed provider response and actual usage; an emitted paragraph is not a completed call.

The Codex CLI adapter uses the official `app-server` stdio protocol for these requests because `exec --json` exposes completed messages rather than text deltas. It starts one ephemeral thread, retains the existing CLI-owned authentication directory, disables configured external capabilities and hooks, and denies tools/approval requests. The executable must support `app-server`; an exec-only socket proxy is not a streaming executable. Calls without `onTextDelta` retain the existing `exec` path. No completed-answer playback or silent streaming fallback is provided.

The new client-session implementation and independent mocked tests have been written. Verification and package publication were not run during this source refactor.


### Native subscription images

`OpenAICodexCliSubscriptionProvider` accepts `complete({ imageGeneration: true, input })` for one native PNG. The result contains `images: [{ data, mimeType, revisedPrompt? }]` and provider-reported `tokenUsage`; an empty final text is valid only when a completed image exists. Text inference keeps image generation disabled. Shell, web, external tools and approval requests remain disabled for both modes. Image requests cannot use a text output schema.

For a Unix-socket host, configure `imageHostSocketPath` on the provider. `startCodexCliHost` serves `/image` using the same concurrency limit, deadline, isolated scratch directory and credential boundary as text calls. The host returns inline bytes, never local paths. Attachment-only, missing, failed or invalid image receipts fail explicitly; there is no image API fallback. Applications retain model routing, quota, audit and storage policy.
