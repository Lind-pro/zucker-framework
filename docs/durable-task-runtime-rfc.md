# Durable Task Runtime RFC

> Status: draft contract baseline
> Scope: `@zucker-framework/task`, `@zucker-framework/queue`, and consuming application adapters

## Problem

Long-running AI, rendering, analysis, and export operations must survive web process restarts, client disconnects, duplicate delivery, and late provider results. An in-process promise or queue alone cannot provide those guarantees.

## Package Boundary

`@zucker-framework/task` owns durable lifecycle semantics:

- State transition rules.
- Idempotency contracts.
- Lease and fencing-token contracts.
- Heartbeat and attempt metadata.
- Lease-fenced, monotonic progress reporting.
- Repository interfaces.
- Outbox dispatch and expired-lease reconciliation contracts.

`@zucker-framework/queue` owns transport and worker execution:

- BullMQ provider and queue registry.
- Worker host and handler discovery.
- QueueEvents, concurrency, graceful shutdown, and health reporting.

Consuming applications own business semantics:

- Task kinds, payloads, results, and handlers.
- Domain database relations and authorization.
- Prompts, model strategy, workflow graphs, billing policy, and user-facing projections.

## Required Guarantees

1. Creating the same idempotency key and fingerprint returns the existing task.
2. Reusing an idempotency key for a different fingerprint is rejected.
3. A task and its initial outbox event are created in the same database transaction.
4. Reusing an outbox event ID with different content is rejected.
5. A queued task can be claimed by only one worker.
6. `claim()` is the only operation that can start a queued attempt and issue its lease.
7. Every active attempt has a lease token and expiry.
8. Heartbeat, progress, completion, and failure writes are conditional on the current live lease token.
9. Progress is monotonic within a task attempt; delayed callbacks cannot move a task backwards.
10. A cancelled or superseded worker cannot commit a late result.
11. Terminal states cannot transition back to an active state.
12. Queue delivery is at least once; business side effects must therefore be idempotent.
13. Pub/Sub and SSE are notifications only. Durable storage is the source of truth.
14. Error summaries and task metadata must not contain full prompts, generated documents, or PII.

## Worker Attempt Runtime

`@zucker-framework/task` also provides `DurableWorkerRuntime`. It owns the reusable control
flow for one durable attempt:

- Terminal-task short circuit and retry-state normalization.
- Atomic claim with a unique fencing token.
- Periodic, non-overlapping lease heartbeat.
- Abort signaling when ownership is lost or storage heartbeat repeatedly fails.
- Lease-fenced progress and explicit pre-commit activity checks.
- Structured retry-policy evaluation and typed retry signaling to queue transports.
- Terminal failure and late-result rejection.

Applications register handlers that own execution and may override completion,
retry, and failure commits when the task row and a business projection must be
updated in one transaction. The runtime does not know application task kinds,
payloads, prompts, billing rules, or projection tables. `@zucker-framework/queue` remains
responsible for transport delivery and worker-process lifecycle.

## Initial Delivery

The first `@zucker-framework/task` increments contain the state machine, repository and
outbox contracts, structured retry policy, worker-attempt runtime, lease
reconciler, Outbox Dispatcher, lease-fenced monotonic `reportProgress`, in-memory
reference implementations, PostgreSQL task and outbox repositories, the
transactional `PostgresTaskSubmitter` with ordered atomic batch submission, and a
publishable Prisma reference schema at
`packages/task/assets/task-runtime.prisma`. PostgreSQL behavior is covered by
embedded PGlite contract tests, but those tests use one embedded database
connection and do not replace real multi-process failure testing. Consuming
applications must create each task and initial outbox event through
`PostgresTaskSubmitter` or an equivalent single-transaction adapter; separate
repository calls are not an accepted production submission path. A business
action that creates multiple child tasks must use `submitBatch` so partial
batches cannot escape on failure.

The integration suite now covers real PostgreSQL multi-connection contention,
repository connection termination and recovery, temporary Redis command
interruption, Worker `SIGKILL` lease recovery, and late-result fencing. The next
increment must still add full Redis/PostgreSQL container outage during Outbox
dispatch, repeated process-kill stress, and rolling-version Worker tests.

The repository includes environment-gated PostgreSQL and Redis contract tests. PR
CI (`pr-checks.yml`) runs both against isolated service containers; before a
`main` push the pre-push hook runs them against the designated NAS via
`scripts/verify-nas-integration.mjs`. Direct local execution uses:

```bash
TEST_DATABASE_URL=postgresql://... \
TEST_REDIS_URL=redis://... \
pnpm test:durable-runtime
```

`pnpm verify:package-artifacts` packs the audited RC set (`core`, `task`, `queue`,
`ai`, `monitoring`, `storage`, `logging`, `credit`, `feature-flags`, and
`notification`), rejects workspace or local-path references, installs the
tarballs outside the monorepo, and verifies both ESM and CommonJS imports. This
is an artifact gate, not a substitute for publishing and installing an actual
release candidate from the selected private registry.

## Release Gate

No consuming application may use the durable task runtime for paid production traffic until all of the following are true:

- Package tests and type generation pass.
- A reference application passes real process-restart tests.
- Published release-candidate packages install without sibling workspace paths.
- The consuming application passes adapter contract tests and task-specific E2E tests.
- The task kind has an independent feature flag and rollback path.
