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

The new client-session implementation and independent mocked tests have been written. Verification and package publication were not run during this source refactor.
