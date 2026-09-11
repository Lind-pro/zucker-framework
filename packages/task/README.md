# Single-process supervisor

`SingleProcessTaskSupervisor` receives `initialize`, `loadPending`, `run`, `abort`, concurrency and scan interval. It deduplicates pending/running keys and marks startup or manually submitted recovery keys for `run(id, true)`. Register the configured instance once at the composition root. Initialization and scanning failures preserve their separate failure paths; shutdown clears queued work and aborts running work without a drain wait.

The consumer owns persistent states, startup state transitions, retry eligibility, progress, billing and checkpoints. This primitive has no database schema, lease, fencing or multi-executor guarantee. It must not be used to justify overlapping executors.

## Execution heartbeat

`runWithExecutionHeartbeat({ signal, heartbeat, intervalMs, failureThreshold }, work)` scopes serial heartbeat attempts to one callback. A successful heartbeat resets the consecutive failure count. At the configured threshold the work signal aborts with `ExecutionHeartbeatError`; the parent signal is unaffected, and the failure remains an error even when work swallows its abort. Caller cancellation forwards its original reason. Work must honor cancellation; the scope does not detach or duplicate it.

The scope clears its timer/listener and awaits an already-running heartbeat before returning. The consumer owns all database writes and decides how heartbeat failure differs from user cancellation or process shutdown. No state table, lease, retry, worker or execution topology is introduced.
