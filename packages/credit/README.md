
# Credit and quota mechanisms

## Generic wallet (`CreditService`)

`CreditService` keeps a balance in `creditAccount` and an append-only ledger in `creditTransaction`.

- Every balance change locks the account row first (a same-value update held until commit) and reads the balance after the lock, so concurrent `consume`/`grant`/`transfer`/`freeze` calls on one account are serialized under READ COMMITTED. Transfers lock both accounts in user-id order.
- `grant`, `consume`, `refund` and `exchange` accept `{ idempotencyKey }` as the last argument. A retry with the same key and parameters is a no-op; reuse with different parameters fails with 409 `CREDIT_IDEMPOTENCY_CONFLICT`. Keys are stored in the `creditOperationReceipts` model (`credit_operation_receipts`, same table as `PostgresCreditOperationCoordinator`), which must exist when keys are used.
- Events are published after commit; a failing event bus is logged and never changes the result.
- `checkExpired()` removes only the unspent remainder of each due grant. The account ledger is replayed with the earliest-expiring credits spent first, so non-expiring credits (paid top-ups, refunds, transfers) are never taken by an expiry. Each grant is claimed once (`expired: false -> true` inside the lock) and the EXPIRE row references it in `orderId`. A failing grant does not block later ones.
- For per-lot holds, revocation and fenced expiry use `BatchCreditLedger` instead.

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

## Fenced credit expiry

`BatchCreditLedger.expireInTransaction(tx, { accountId, lotIds, transactionData }, now)` expires only selected owned lots whose deadline has arrived, under the existing account lock. It re-reads each remaining amount, updates the canonical account and writes one journal row per newly expired lot on the supplied transaction. This lets a consumer include its active job lease fence and business state in the same commit. Duplicate or stale selections do not debit twice. The existing `expire()` scanner delegates to this method; it does not become a scheduler.

Credit lots and periodic quota counters are distinct ledgers. `QuotaReservationService` and `QuotaCapacity` do not freeze credit lots or authorize spending a wallet. A consumer that requires monetary credit holds needs lot-aware hold allocation and consumption exclusion, not a counter reservation mapped into a balance field.

## Wallet lot holds

Configure `BatchCreditLedgerOptions.holds` with a `CreditLotHoldStore` on the same transaction/account-lock boundary as the existing lot and balance models. Without this optional port, existing ledger callers retain their behavior. With it, `consume()` excludes each lot's active held amount, including when it falls back from a preferred source. An unrelated `revokeUnused()` fails with `CreditLotHeldError` if its selected lots have active holds.

- `hold(tx, { id, accountId, amount, lotIds, resourceType, resourceId, operationKey, transactionData })` reserves an exact positive integer from selected owned unexpired/unspent lots and moves available `balance` into `frozenBalance`. Every selected ID must belong to the account. It cannot borrow from other source lots.
- `confirmHold(tx, { id, accountId, operationKey, transactionData, expiryTransactionData? })` revokes only this hold's remaining active allocations, reducing their lot remainder and frozen balance.
- `releaseHold(tx, ...)` restores only remaining active allocations from frozen to available balance. It never refunds already-consumed credits.

Each operation uses the supplied transaction and the common account lock, then the existing operation-receipt coordinator with a fixed hold phase and identity. The caller provides stable operation keys and transaction descriptions/references. The return value is `{ hold, changed }`; `hold.amount` remains the original amount, while `activeAmount`, `expiredAmount`, `revokedAmount` and `releasedAmount` sum to it. Replays do not repeat money/credit movements; an opposite terminal decision is a conflict. The optional `now` parameter is a caller-owned decision clock; by default settlement samples time after acquiring the account lock.

Holds have no TTL. Unknown provider outcomes must not be resolved by automatically releasing a hold. Natural lot expiry moves active allocations into permanent expired evidence and reduces the corresponding frozen amount; it does not decide the hold's overall status. Confirmation/release first expires due source lots on the same transaction, so a late result cannot revive expired value. Expiry journals record the whole lot remainder and include `frozenBalanceBefore` / `frozenBalanceAfter` alongside available-balance changes. A refund-specific reconciliation must use its returned hold allocation totals rather than treating a whole-lot expiry journal as that refund's exclusive amount.

Persist original allocation amounts, monotonic settled/expired amounts and immutable expiry evidence. The store's allocation update is an exact old-value CAS and its settlement is `HELD` to terminal CAS; a rejected write is not success. The consuming transaction must roll back receipts, allocation changes, balances and journal together on failure. Provider I/O belongs outside that transaction. Cash-to-credit conversion, source selection, refund authority and cash payment state remain consumer policy.

When holds are configured, every stored frozen credit must have a matching active lot allocation. `CreditHoldMigrationRequiredError` explicitly refuses legacy unallocated freezing; the package does not guess its source or hide mismatches by clamping balances. Migrate/reconcile such accounts before enabling the port. The template enables the port for its canonical ledger and rejects inconsistent read projections as well. Total available plus frozen credit is bounded to the supported integer range, preserving headroom for a later full release.

## Plan entitlements

`EntitlementService` (and the underlying functions) holds no product data: the consumer declares an
`EntitlementCatalog` of features (`metered` with a `counter`, or `benefit`) and counters
(`month` / `day` / `lifetime`) in code. `validatePlanGrant` accepts boolean features and quotas of
`-1` (unlimited) or non-negative integers, all keys declared. `counterLimit` treats a metered counter
missing from a plan as no allowance and any other missing counter as unlimited. `isActiveTerm`
accepts ACTIVE/CANCELED terms that have started and have a future end, and ACTIVE LIFETIME terms with
no end. `periodKey` formats `YYYY-MM` / `YYYY-MM-DD` in an IANA time zone (default UTC) or
`lifetime`. `resolveEntitlements` turns a plan grant and term into catalog-wide features and limits
(inactive → everything off, limits 0); `counterSnapshot` builds the `{limit, used, reserved,
remaining, period}` presentation where `-1` stays unlimited. `QuotaCapacity` still never interprets
negative limits: consumers skip the capacity check for `-1` explicitly.

## Charge once per resource

`ResourceChargeService` wraps `QuotaReservationService` so one resource (for example a project)
consumes each counter once. The charge identity is `(subject, counter, resourceType, resourceId)`:
the same project metered by `projects` and by `exports` is charged once on each counter. Its
`ResourceChargeLookup` port runs on the reservation transaction after the subject/counter lock:

- `expireStale(tx, query)` moves RESERVED rows of exactly that identity whose `expiresAt` has passed
  to EXPIRED (never confirming them), so a crashed or overlong use cannot block the resource;
- `findActiveCharge(tx, query)` returns `'CONFIRMED'`, `'RESERVED'` (live) or `null`.

A CONFIRMED charge makes the use free (`{ reservation: null, free: true }`). A live reservation of
another request rejects with `ResourceChargeError('in_progress')` (409 through admin's port mapping)
instead of a free use, so a first use that later fails can never leave a second successful use
uncharged; retry after it settles. A reused reservation ID that names another resource rejects
with `ResourceChargeError('conflict')`. Otherwise `begin` reserves; `complete` confirms after the
first successful use and `fail` releases so a later attempt can charge again. `run(input, work)`
composes the three: a work failure releases and rethrows (release failures go to
`onReleaseError`); a confirmation failure after successful work (reservation expired because the
work outlived its TTL, an administrator released it, storage failed) is reported to
`onConfirmError` and the work's result is returned uncharged — keep the TTL longer than the work.
Every method accepts `{ tx }` to join a caller transaction (for example a task insert and its charge
in one commit); inside a caller transaction a confirmation failure is rethrown.

Storage must allow a new reservation for a resource whose earlier charge was released or expired,
and must hold at most one RESERVED/CONFIRMED row per identity. The server template keeps a nullable
`activeResourceKey` (`@unique`; set while RESERVED/CONFIRMED, cleared by the terminal transition,
guarded by a CHECK constraint), which Prisma can represent — avoid partial unique indexes, which
`prisma migrate diff` cannot model. PostgreSQL behavior is covered by
`templates/server/test/back-office.persistent.e2e-spec.ts`.

Domain errors (`QuotaReservationError`, `ResourceChargeError`) are branded port errors whose `reason`
belongs to `PortErrorReason` from `@zucker-framework/fe-types/back-office`.
