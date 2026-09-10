# Common package consumer contracts

`TransformInterceptor` wraps ordinary controller results in the standard API envelope. A Nest `StreamableFile` passes through unchanged so the HTTP adapter can send its stream and file headers.

`pLimit(items, concurrency, fn)` keeps its existing behavior: an item failure appears in the corresponding result slot. Callers that require promise rejection can opt in:

```ts
const results = await pLimit(items, 3, processItem, { rejectOnError: true });
```

In rejection mode, the original failure rejects the returned promise and queued work is no longer dispatched. Already running operations are not cancelled. Successful results retain input ordering and the concurrency bound is unchanged.

These changes have focused source tests in `packages/common/src/interceptors/transform.interceptor.spec.ts` and `packages/common/src/utils/p-limit.spec.ts`. They require a new package release before a registry consumer can rely on them; the existing published bytes must not be replaced.
