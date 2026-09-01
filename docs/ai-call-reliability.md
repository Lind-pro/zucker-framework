# AI Call Reliability Contract

## Boundaries

- Durable business deadlines, attempts, and recovery belong to `@zucker/task`.
- `@zucker/ai` owns one Provider attempt: cancellation, optional per-attempt deadlines, error classification, and safe observation.
- Provider adapters must pass the attempt `AbortSignal` to the underlying SDK or HTTP request.
- A client disconnect must not be reused as a business task deadline unless the caller explicitly cancels the durable task.

## Required Usage

```ts
await wrapper.callWithRetry(
  ({ signal }) => provider.generate(input, { signal }),
  {
    signal: workerSignal,
    timeoutMs: providerAttemptBudgetMs,
    maxAttempts: 2,
  },
);
```

`timeoutMs` has no default. When provided, it aborts the attempt and raises `AICallTimeoutError`. Timeout retries are disabled unless `retryTimeouts: true` is explicitly set, because a Provider that ignores cancellation could otherwise run duplicate expensive requests.

## Observation Safety

- Observer events omit full model results by default.
- Observer metadata is sanitized by default; prompt, messages, content, documents, claims, specification, technical disclosure, credentials, email, and phone fields are redacted.
- Long metadata strings and observer error messages are truncated to 280 characters.
- `observerResult: 'full'` and `observerMetadata: 'full'` are explicit high-risk opt-ins and must not be used for sensitive workloads.

## Media Providers

`MediaGenerationService` does not impose a 120-second or 300-second default timeout. Caller cancellation and an optional timeout are propagated to DALL-E/OpenAI, Stability, Kling, Runway, and Replicate adapters.
