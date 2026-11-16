# @zucker-framework/ai-tasks

Durable, credit-metered asynchronous AI media generation (image, video, audio) on top of
`@zucker-framework/task`. One service covers submission, the worker handler, provider callbacks,
output re-hosting and owner/management read projections. Product policy (prices, catalog, HTTP,
permissions, storage location, ledger journal text) stays in the application and reaches the
package through ports.

## Persistence

`assets/ai-tasks.prisma` (models) and `assets/ai-tasks.postgresql.sql` (DDL, also exported as
`AI_TASKS_POSTGRESQL_SCHEMA`) add `ai_tasks` and `ai_task_outputs`. They require the durable task
tables of `@zucker-framework/task` (`async_jobs`, `async_job_outbox`). `ai_tasks.id` equals the
`async_jobs.id`; the durable row owns status, lease and fencing. Add the CHECK constraints from the
SQL file to the Prisma migration. Prompts live in `async_jobs.payload`; credentials are never stored.

Existing installations must apply `assets/ai-tasks.execution-checkpoints.postgresql.sql` before
starting the new worker (the server template includes the same additive migration). Stop/drain old
workers first: mixing old/new workers is unsafe because old workers do not understand the paid-submit
checkpoint. The upgrade treats already-attempted legacy rows without a provider task id as an unknown
submission, never as a fresh request. Before rolling back to old workers, finish or explicitly cancel
all active checkpointed tasks; retaining the new columns alone does not make an old worker safe.
No existing migration is rewritten. The additional fields are `executionState` and `generatedOutputs`.

## Service

```ts
const aiTasks = new AITaskService<Tx>({
  transactions,   // { runInTransaction(work: (tx: Tx) => Promise<T>) }, Tx is a PostgresTaskClient
  holds,          // CreditHoldPort<Tx>: place / confirm / release on the caller's transaction
  costs,          // AICostResolver: server-side integer price (0 = free)
  outputs,        // OutputStorePort: idempotent private store per (taskId, index)
  providers,      // AITaskProviderResolver: provider + server config (apiKey ...) at execution time
  callbacks,      // optional AITaskCallbackVerifierResolver (providerId -> verifier)
  wake,           // optional host wake hint, e.g. (id) => jobs.wake(id)
});
```

- `submit(tx, { ownerId, kind, providerId, model, input: { prompt, options?, references? }, idempotencyKey, cost? })`
  validates (exact keys; credential/transport/model option keys refused), prices through
  `AICostResolver`, and writes the durable task, its outbox intent, the `ai_tasks` row and the credit
  hold in the caller's transaction. Insufficient credit (`AITaskInsufficientCreditsError` from the
  hold port) rolls everything back. The idempotency key is unique per owner: the same request returns
  the existing task (`created: false`, no second hold) even after a price change; a different request
  with the same key throws `AITaskIdempotencyConflictError`. A `cost` the client was quoted must equal
  the resolved price (`AITaskCostChangedError`). `submitAndWake(command)` runs its own transaction.
- `cancel(tx, ownerId, id)` / `cancelOwned(ownerId, id)`: CANCELLED and hold release in one commit;
  `null` for unknown or foreign ids.
- `handleCallback(providerId, rawBody, headers)` returns `{ providerKnown, verified, action }`. Only a
  verifier-accepted callback can record an outcome (first one wins, settled once by the lease owner).
  An unverified callback can at most bring one poll forward: `verifier.hint(rawBody, headers)` (optional
  on `@zucker-framework/ai`'s `AIProviderCallbackVerifier`; implemented by the HTTP async adapter and
  `FakeCallbackVerifier`) names the claimed provider task, and an early poll is scheduled at most once
  per `polling.earlyPollMinIntervalMs` (default 10 s) per task. It never touches status, results or holds.
- Readers: `get(ownerId, id)`, `list(ownerId, { limit, before, kind, status })`,
  `listForManagement({ ownerId?, kind?, status?, promptLimit })`, `getForManagement(id)`,
  `findOutput(ownerId, id, index)` (server-side storage key for download tickets, COMPLETED only).
  Projections never include provider task ids, raw provider payloads, hold ids or storage keys.
- `reconcileHolds(limit)` releases holds of tasks that ended outside the handler (lease recovery after
  the last attempt, unsupported kind, external cancel). Register it as a periodic wake source.

## Worker

`aiTasks.registration()` returns `{ kind: 'ai.media', version: '1', handler, maxAttempts }` for a host
built on `DurableWorkerRuntime`. No lease or worker slot is held while a provider works: every poll
is a short run that ends by requeueing the durable row at `nextPollAt` (the runtime's "retry at"
path, `DurableTaskRetryScheduledError`), so long video/audio jobs cannot starve the queue. The host's
`TaskQueueReconciler` (or a `wake` hint, also fired by an in-process timer) runs it again when due.

| Step | Durable status (owner view) | Hold |
|---|---|---|
| submit | QUEUED | HELD (NONE when free) |
| claim | PROCESSING | HELD |
| provider accepted: task id + nextPollAt stored, PROCESSING -> RETRYING -> QUEUED(availableAt = nextPollAt) in one lease-fenced transaction | QUEUED (shown as WAITING_PROVIDER) | HELD |
| due run: one status poll (or a stored verified callback outcome); pending -> defer again with exponential backoff (cap `polling.maxDelayMs`) | PROCESSING, then QUEUED (WAITING_PROVIDER) | HELD |
| success: outputs downloaded and stored | PROCESSING (stage `storing`) | HELD |
| commit (one fenced transaction) | COMPLETED + `ai_task_outputs` | CONFIRMED |
| provider failure, deadline (`polling.maxWaitMs`), `maxConsecutivePollErrors`, rejected output, failure budget | FAILED (one fenced transaction) | RELEASED |
| owner cancel (also while waiting) | CANCELLED | RELEASED |
| lease lost / host shutdown | requeued by `TaskLeaseReconciler`; the next run resumes from the stored provider task id | HELD |

`maxAttempts` (default 3) is the failure budget. The durable row's `maxAttempts` additionally allows
one claim per poll run up to the deadline (`polling.maxPolls` overrides); `ai_tasks.deferrals`
separates poll runs from failed runs. Provider submission is never retried automatically (it is
billed and not idempotent). Every worker write
is fenced by the attempt lease, so a stale attempt cannot write results, schedule polls or settle holds.

The execution checkpoint is separate from the task lease: `NEW → SUBMITTING` is committed before a
paid call; `ACCEPTED` records an async provider id; `GENERATED` records bounded output URLs/inline bytes;
`STORED` records all verified private outputs and clears the generated snapshot. Storage retries use
the snapshot and per-index output rows. Settlement retries use `STORED`, without contacting the provider
or uploading again. Terminal failure/cancellation clears the snapshot and releases the hold atomically.
Inline snapshots can be as large as the configured output cap; they are private recovery data, never
logs or owner/management projections, and are removed after storage or terminal settlement.

A process interruption, ambiguous transport failure or lost checkpoint acknowledgement can leave
`SUBMITTING`. An optional `providers.recoverSubmission(request, signal)` port performs a **read-only**
lookup by `request.taskId`; it must never generate. The same task id is sent as trusted
`MediaGenerationConfig.clientRequestId` (HTTP adapters may explicitly map it to a vendor request field).
Return a known task/result, or `null` while still unknown; polling/retry remains bounded by the original
deadline. Without a recovery port, an unknown outcome ends with `AI_PROVIDER_SUBMISSION_UNKNOWN` and a
refund, never a second paid call. This prevents automatic duplicate submission; it does not claim that
an external provider can guarantee exactly-once effects or that an unknown paid result was recovered.

## Lock order

Every transaction that writes or row-locks both tables takes the `async_jobs` row first, then the
`ai_tasks` row, then `ai_task_outputs`, then the credit ledger (through `CreditHoldPort`). The task
repository (cancel, transitions, claims, lease recovery) only touches `async_jobs`, so store methods
that also write `ai_tasks` (poll deferral, verified callbacks, early polls, hold settlement) first run
`SELECT ... FROM async_jobs WHERE id = $1 FOR UPDATE` (`PostgresAITaskStore.lockJob`). Note that
`UPDATE ai_tasks ... FROM async_jobs` does not lock the joined row. A cancel racing a completion or a
deferral therefore serializes instead of deadlocking.

## Output re-hosting

Each output (URL or inline base64) is read with a byte cap per kind (`outputLimits.maxBytes`, defaults
image 20 MiB, video 200 MiB, audio 50 MiB), accepted only when its sniffed type is an allowed
raster/audio/video type (never SVG/HTML), hashed and handed to `OutputStorePort`. URLs are fetched with
core's `createPublicFetch` by default: https on port 443, public resolved addresses pinned for the
connection, no redirects. A declared `Content-Length` above the cap is refused before reading.
`outputLimits.downloadTimeoutMs` (default 120 seconds) bounds each output's download and storage,
including retries and stream reads. A timeout aborts the signal, cancels the source reader, fails the
task with `AI_OUTPUT_TIMEOUT` and releases its hold. Ports must check cancellation before starting new
operations and stop/clean partial writes when their underlying storage supports cancellation.

When `input.options.count` is supplied, the complete provider batch must match it; a short batch fails
with `AI_OUTPUT_COUNT_MISMATCH` and refunds the hold instead of charging for undelivered outputs.

When the port implements `putStream`, nothing is buffered whole: the first 64 bytes are read and
sniffed before any byte reaches the store, then the output flows through a stream that hashes and
counts and errors as soon as the cap is exceeded (`AITaskOutputRejectedError('too-large')` -> task
FAILED `AI_OUTPUT_REJECTED`, hold RELEASED). The store must remove a partial object when the stream or
the write fails, must be idempotent per (taskId, index) (it may return the object it already has
without reading the stream) and returns `{ storageKey, bytes, sha256 }`, which is cross-checked with
the streamed digest. A source transport error mid-stream is retried (`downloadAttempts`); a store
refusal thrown as `AITaskOutputRejectedError('quota')` fails the task with `AI_OUTPUT_QUOTA_EXCEEDED`
without retrying. Inline base64 is decoded in memory, bounded by the cap before decoding. Without
`putStream`, `put` receives the bounded buffer (as `createVerifiedOutputStore` does).

## Adapters (`@zucker-framework/ai-tasks/adapters`)

- `createLedgerCreditHoldPort({ ledger, spendableLotIds, transactionData })` maps
  `BatchCreditLedger` wallet holds (optional peer `@zucker-framework/credit`).
- `createVerifiedOutputStore({ store, prefix })` writes through `transferVerifiedObject` of
  `@zucker-framework/storage` (optional peer) under `<prefix>/<taskId>/<index>.<ext>`.
  It checks cancellation before/after every buffered-store operation, preventing a late read/exists
  completion from starting another upload. The legacy `BufferedObjectStore` has no abort/delete API:
  an already-started remote write cannot be forcibly cancelled or deleted by this adapter. Use a
  cancellation-aware `putStream` implementation when that storage guarantee is required.

## Tests

`src/ai-task.integration.spec.ts`, `src/ai-task.gates.integration.spec.ts` and
`src/ai-task.output-cap.integration.spec.ts` run against PostgreSQL when `TEST_DATABASE_URL` is set.
`src/ai-task.recovery.spec.ts` uses embedded PGlite for checkpoint rollback, recovery, migration and
settlement contracts; it does not replace real PostgreSQL concurrency tests. `output-deadline.spec.ts`
checks abort races around lease renewal and the buffered storage adapter.
