# @zucker-framework/queue

`BullMqQueueProvider` owns producers; `BullMqWorkerHost` owns workers. Consumers retain outboxes, transaction boundaries, authorization, quota decisions and cancellation policy. Neither transport makes a business transaction atomic.

## Producer lifecycle

Construct with explicit `connection` and optional `prefix`, `onError(queueName, error)`. Call `waitUntilReady(['queue-name'])` to prewarm producers without adding a job; the no-argument form only waits for already-created queues. Close producers **after** gracefully closing workers that may still publish work. Error callbacks should redact connection errors before logging.

`addBulk(queueName, entries)` on the BullMQ adapter preserves native bulk submission, validating all job IDs before creating the queue; empty batches create no connection. `add` preserves stable transport IDs. `ensure` may replace terminal records: do not use it when a terminal job must remain evidence for outbox failure reconciliation. `getJob` exposes normalized status and failed reason. `getStats` combines waiting/prioritized with a read-only legacy paused-list count; BullMQ 6 does not accept `paused` as a getJobCounts type. This does not resume or migrate legacy queues and is not proof of v5→v6 compatibility. `getJobCounts(queueName)` retains BullMQ's native default count keys (including `waiting-children`) for backend-specific monitoring contracts without merging counts.

## Workers

`register({ queueName, handler, concurrency, lockDurationMs, stalledIntervalMs, autorun })` requires positive safe-integer settings. Handler jobs include `attempt` (one-based) and `maxAttempts` (configured budget, default 1), allowing product terminal-attempt policy without reaching into raw BullMQ jobs. BullMQ unrecoverable errors can still be thrown directly by a handler.

`close(false)` drains workers; concurrent calls share the same drain promise. Every close is awaited even if another close throws/rejects; failures are reported together as `AggregateError`, so a failed drain cannot signal completion while another worker is still active. Closed hosts/providers cannot register workers or reopen producers. Force closing has different recovery implications. `probeHealth` is a bounded read-only connection probe, not a task execution probe. Test with fake factories or explicitly isolated disposable Redis; never use existing queues for compatibility experiments.

New prewarm/error/retry-budget/stalled-interval contracts are local source additions pending a new formal release; 1.0.2 consumers must not import sibling source to obtain them.
