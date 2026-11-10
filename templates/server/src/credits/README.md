# Account credits and optional record quota

`CreditsModule` reuses the canonical `creditAccount`, `creditTransaction`, `creditLots` and the billing ledger adapter. Its owner-scoped read API exposes usable credits, frozen credits and cumulative expired credits, plus paginated journal and batches. Available credit excludes already-due batches before maintenance posts its expiry journal. Reads never mutate balances. Account balance is the existing canonical field; frozen balance keeps its existing wallet meaning and is not a periodic quota.

`GET /credits/balance`, `GET /credits/transactions?page=1&pageSize=20&type=GRANT` and `GET /credits/lots?page=1&pageSize=20` require the current account. Pages are 1–10000 with sizes 1–100. The journal retains lot IDs, order IDs and safe source references, while the existing permission-gated administrator `/credit/_query` reads the same canonical journal for audit.

`CreditsRuntime` registers `credits.expire` and a wake source with the one `JobsHost`. Scans select due lots without starting another timer. The job's lease-fenced completion, lot expiry, balance decrement and `EXPIRE` journal share a transaction. A replayed payment receipt cannot recreate a previously issued lot. Failed maintenance remains a persistent failed task for operational review; repeated scans do not create endless replacement attempts or block newer lots behind failed ones.

Periodic quota is separately optional. When `QUOTA_RECORD_LIMIT` is empty, `POST /jobs` record operations have no counter charge outside production; with `NODE_ENV=production` an empty value means 100 per period, and `QUOTA_RECORD_LIMIT=off` explicitly disables the counter. A positive server-defined limit enables a fixed charge of one record per operation. `QUOTA_RECORD_PERIOD=daily|monthly` uses UTC boundaries; `QUOTA_RESERVATION_TTL_MS` defaults to 900000 and must be 1000–86400000. A reservation cannot outlive its captured period. Limit, period, policy version and resource identity are immutable per reservation. Configuration changes do not rewrite accepted work.

The real `record` task is the example resource. Task and outbox creation reserve quota on the same transaction. Durable result completion confirms quota usage on that transaction; a failed usage write rolls the result and task completion back. User cancellation and normal final failure release the reservation with the task transition. `quota.reconcile` repairs expired or crash-terminal reservations through the same host and fenced transaction. No client endpoint can manufacture a confirmed quota consumption. `GET /quota/record` and owner-scoped `/quota/reservations` / `/quota/reservations/:id` expose actual captured state.

Consumer extensions can register `JobsService.registerTransactionHooks` before bootstrap. Submission and user cancellation run through the service; a handler that owns business transactions must explicitly invoke completion/failure hooks in those transactions, as the default record handler does. Hooks must acquire resource locks after the task row and must not send external notifications before commit. Quota storage adapts public `QuotaReservationService`, `QuotaCapacity` and the common account-lock coordinator instead of creating a second state machine. Every quota writer takes the same subject/counter lock.

`canCancel` on owned task summaries is the capability to use for cancel controls. Internal billing, credit and quota maintenance jobs can be inspected by their owner but cannot be cancelled through the user endpoint. A UI must not infer cancellation permission merely from task ownership.

## Refund wallet holds

The canonical billing ledger now configures `createCreditHoldStore()` for every caller. Wallet holds are separate from `quota_reservations`: they move available balance to frozen balance and allocate that freeze to exact source lots. `consume()` automatically excludes those amounts; a future feature must not bypass this shared ledger by writing the old account field directly.

Migration `20261024001000_credit_holds` adds immutable hold identities, conserved per-lot allocations, expiry evidence and nullable frozen before/after journal fields. The framework's `hold`, `confirmHold` and `releaseHold` APIs operate only on the caller's transaction. A refund host owns cash conversion and authorization, locks its resource consistently with the account, and performs provider I/O outside the database transaction. No refund cash endpoint or automatic TTL is introduced by the hold adapter.

A lot's natural expiry removes its free and frozen remainders together. The original hold amount and expired allocation remain visible; later success/failure can only revoke/release still-active allocations. Unknown outcomes remain `HELD`, even when their active amount has naturally expired to zero. The owner balance projection excludes already-due allocations from effective frozen/available values before maintenance, and exposes separate book balances. It explicitly rejects unexplained legacy frozen amounts or account/lot mismatches instead of guessing a migration. Journal reads remain available for audit.

## Confirmed refunds awaiting credit recovery

The template's `createCreditLedger` adds source eligibility around the public ledger. Under the same
account lock used to persist owned cash evidence, it excludes a payment's source lots while a
successful refund event is still unapplied or confirmed cash requires credit recovery beyond the
recorded recovered amount. This also covers the interval before a recovery hold can be created.
Other purchase sources remain usable. The public `BatchCreditLedger` contains no refund policy.

Ordinary consumption cannot select a blocked source; new business holds and confirmation of active
business allocations on that source are rejected. Safe no-op hold/confirmation replays remain
idempotent. Release and natural expiry remain available, but released blocked value never becomes
usable while recovery is incomplete. Only the refund host's explicit
`createCreditLedger(database, { refundSettlement: true })` channel may create or confirm
`refund-request` / `refund-observation` holds; it cannot bypass consumption eligibility.

Balance and lot projections acquire that same account lock before their reads. `refundBlocked`
reports still-valid blocked value that is not already in a real hold; it is separate from `frozen`
and `expired`. Book balance and stored frozen balance are unchanged. Lots expose
`refundBlockedAmount`, zero `availableAmount`, and `status: 'refund_pending'`; an entirely held lot
may have that status with zero additional refund-blocked amount. Expired and consumed statuses take
precedence. Recovery clears eligibility restrictions when durable cash evidence is applied and
the corresponding credit recovery is complete.

`test/refund-credit-blocks.persistent.e2e-spec.ts` covers these consumer boundaries with real
PostgreSQL. The refund host's HTTP failure and concurrency tests separately verify the cash-proof,
hold-write and recovery windows. No new schema or remote provider call is needed.
