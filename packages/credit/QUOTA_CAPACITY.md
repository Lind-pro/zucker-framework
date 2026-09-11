# Periodic quota capacity

`QuotaCapacity` provides shared checking and atomic consumption over an explicit `QuotaCapacityStore`. The caller supplies subject/counter/period, amount, numeric limit and a transaction-bound store; the package does not select subscription plans, define unlimited quotas or emit product events.

The store acquires the same capacity lock as reservation writers, atomically creates/updates the configured limit without resetting usage, returns outstanding reservations, and conditionally increments only when the persisted `used` value fits the remaining capacity. Every method must use the same caller-owned transaction. Database failures propagate; a failed conditional increment throws `QuotaCapacityExceededError` with the observed usage/reservation snapshot.

Check and consumption share reservation accounting: expired reservations and explicitly different periods do not count; unknown legacy periods remain counted conservatively. Missing expiry is also treated conservatively. Numeric negative limits never mean unlimited; applications must handle their explicit unlimited configuration before invoking the primitive. Invalid increments and corrupted negative usage/reservation amounts fail rather than granting capacity.

Application adapters map model/column names and metadata to this port. Configure limits and cycle names there. Preserve post-commit business events and any existing lock ordering. This primitive neither creates a schema nor enables reservation APIs that a consumer does not currently use.

Independent unit and consumer adapter regression sources are included; they have not been executed during the current verification pause. Database concurrency, rollback and application acceptance remain required before release.

See also [batch credit accounting](BATCH_LEDGER.md), which implements source-qualified FIFO lots rather than periodic capacity.
