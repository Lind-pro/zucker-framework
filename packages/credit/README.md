
# Credit and quota mechanisms

## Durable quota reservations

`QuotaReservationService<Tx, Record, Input>` provides reserve, confirm, release and
expiry transitions through `QuotaReservationStore`. It does not install tables,
create a scheduler, or choose entitlement policies. Map the store to existing
records and use one real transaction for the status CAS and charge. A failed
charge must roll both back. `lock` must serialize every writer of the same
subject/counter, including direct consumption; the service re-reads the record
after acquiring it. Unique reservation IDs must be enforced by persistence.

`reserve` calls the consumer's capacity/entitlement policy inside that transaction
and under the same lock. An existing stable ID is reused only when subject,
counter and amount match and its state is confirmed or still reserved/unexpired.
Consumers retain period/limit/resource metadata in their record subtype.
`confirm` charges that captured record rather than reconstructing today's period.
`transition` must perform an atomic expected-state update and honor the expiry
predicate; returning true without a successful CAS violates the contract.

Confirmation/release return true only when they changed state. Repeated
confirmation does not recharge; releasing confirmed records does not refund.
Refunds are a separate business operation. `expire` delegates a bulk conditional
transition for expired RESERVED rows; it never charges or changes confirmed rows.
`QuotaReservationError.reason` distinguishes invalid input, missing records,
identity conflicts and inactive records so consumers can retain their HTTP and
language conventions. Storage failures propagate unchanged.

The transaction/store ports intentionally do not publish notifications: consumers
must emit only after commit, or write an outbox in the same transaction. Synthetic
port tests verify transitions and rollback ordering, not PostgreSQL constraints,
cross-process locks, or exactly-once external event delivery.

## Revoke unused lots

`BatchCreditLedger.revokeUnused(tx, { accountId, lotIds, transactionData })` removes only the
remaining value of the selected lots under the existing account lock, updates the cached balance
and appends one journal entry on the supplied transaction. Repeating the command returns zero.
The caller owns lot selection and refund/entitlement policy; consumed allocations remain intact.
