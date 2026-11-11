# Persistent refunds in the server template

`BillingRefundsService` (now in `@zucker-framework/back-office/billing`; this template configures it) consumes the public `RefundAdapter` protocol and the existing PostgreSQL
credit ledger. Adapter credentials, paid money, local payment identity, original credit policy and
source lots are derived on the server. An administrator can select only a local order/cycle, exact
amount and optional reason. The required permission is `billing:refund`; mutations also require a
trusted Origin. Responses use `Cache-Control: private, no-store`.

## Cash and credits are separate facts

A payment target records the verified original funding source and aliases (for example, a Stripe
invoice/payment intent and its real charge). Unique actual refund receipts, verified webhook events
and provider cumulative totals are retained separately. Cumulative cash is the maximum of known
cumulative evidence and the sum of unique successful receipts; a cumulative total is never added as
another individual receipt. The original payment and subscription lifecycle are preserved.

Credit recovery uses `floor(originalCredits * cumulativeRefundMinor / originalPaidMinor)`. The last
full refund therefore recovers the rounding remainder. Before an administrator's cash command, the
ledger holds only unspent lots from that exact purchase or subscription cycle. Insufficient credits
reject before provider dispatch. An external provider-dashboard refund is still recorded when the
credits have been spent: available source credits are recovered and the actual shortfall needs
attention. No negative balance or claim against an unrelated credit purchase is created.

A hold has no timeout while the cash result is uncertain. Natural expiry is accounted for by the
ledger: releasing a failed refund restores only still-valid credits, and confirming a successful
refund does not debit expired credits twice. An expired amount shown on a failed request is the
hold's expiry outcome; it does not count as a successful cash refund or target credit recovery.

Verified refunds before initial fulfillment suppress the corresponding credit grant. Confirmed full
refunds preserve the original payment/fulfillment facts with zero granted credits. Unknown or pending
refunds block positive grants until evidence resolves them. Provider reads happen outside ledger
transactions; the final grant gate rechecks durable restrictions under the account lock.

## Command and recovery boundaries

`POST /api/billing/refunds` requires a stable `Idempotency-Key` scoped to the authenticated actor.
The body is `{targetType: 'order' | 'cycle', targetId, amount: string, reason?: string}`. Identity,
currency, account scope and credit quantities cannot be injected by the client.

`prepared` means the hold is durable but no provider command has been claimed. A same-key explicit
POST can claim this request. The claim commits `submitting` before the single external `create` call.
Every subsequent state, including an unknown transport result, is replayed without dispatch. Provider
idempotency support adds protection but is not used to justify automatic resubmission.

`GET /api/billing/refunds/requests/:clientKey` finds the authenticated actor's existing command without
provider I/O and returns 404 if absent. A browser can retain its original key across a lost response
and reload. A lookup must not infer identity from matching amounts or issue a replacement key while
an old request remains uncertain.

`POST /api/billing/refunds/:id/check` and target checks read existing provider facts and apply durable
evidence. They never dispatch. Real provider receipt IDs and cash responses are journaled before
credit settlement, so a failed ledger write cannot erase the cash result. A definitive provider
rejection is likewise saved before releasing its hold. Operators can recheck the same request after
repair; they do not need another cash command.

`cashState`, `creditState` and `reconcileStatus` are independent. Exhausted background retries are
reconciliation attention, not proof of cash failure. A cash-success/credit-pending result is not shown
as fully complete. Unmatched events and events attached to targets with credit shortfalls remain
available from `GET /api/billing/refunds/events`.

Provider evidence limits remain explicit. Stripe may correlate refund history and actual charge
aliases; PayPal capture and sale references remain distinct. Creem's status-only acknowledgement
cannot invent a refund receipt. A verified fully refunded payment total can complete an uncertain
request with `confirmationBasis: 'payment_total'` without fabricating an individual refund ID.

## Persistence and verification

Migrations `20261024001000_credit_holds` and `20261024001100_refunds` install source-lot allocations,
refund payments/aliases/requests/receipts/events, foreign keys, unique active requests and immutable
identity/conservation checks. The migration adds tables and guards; rollback requires preserving cash
and hold history, stopping refund operations and explicitly resolving active holds first. Removing
history while real provider operations may exist is not a safe rollback.

`test/refunds.persistent.e2e-spec.ts` exercises real Nest HTTP/auth, disposable PostgreSQL schemas,
all migrations and credit effects with injected provider substitutes. It covers authorization,
rounding, concurrent key replay, source-lot insufficiency, held spending, restart recovery, ledger
write failures, natural expiry, early refunds, external refunds, cumulative pending amounts,
Creem aggregate proof and subscription cycle isolation. The runtime fencing suite is
`test/refunds-runtime.persistent.e2e-spec.ts`. No real cash/provider-account operation is needed for
these checks.

## Confirmed external refunds during credit-write failures

Cash journal/receipt and cumulative payment writes commit before credit hold/settlement transactions.
The consumer credit ledger excludes the exact source lots while a verified successful event has not
been applied or confirmed cumulative cash still requires credit recovery. This protection remains
effective when creating the recovery hold itself fails, not just when confirmation fails. Other
purchase/source lots remain eligible. Ordinary business holds cannot newly reserve or confirm those
credits; release and natural expiry remain allowed. Only the private refund settlement channel may
reserve/confirm them for refund recovery, and even that channel cannot consume them as ordinary usage.
No refund policy is added to the public BatchCreditLedger.

`refundBlocked` in balances and `refundBlockedAmount` / `refund_pending` in lot projections describe
unheld credits temporarily unavailable for refund reconciliation. They do not fabricate a frozen
ledger amount. A partial refund temporarily blocks its affected source during uncertainty; exact
successful recovery releases the unrefunded remainder for normal use.

Known-owner successful proof writes use the same account lock as consumption. A source advisory lock
also serializes unknown-owner webhook journals with later payment registration. Known-owner work
uses account → source → target order; unknown-owner work holds only source and releases it before
retrying with a newly discovered owner, avoiding inverted lock order.

A verified cumulative-only successful event can update the monotonic cash total and become processed
without inventing a provider refund ID or individual receipt. After credit recovery, that processed
evidence no longer blocks a valid partial remainder.

If a process stops after the raw successful journal commits but before target cash accounting,
`getTarget` returns `cashEvidencePending: true`, `attention: true` and `canCreate: false`. Its money
fields are the target's last applied totals, so the UI must show pending cash verification instead of
interpreting an applied zero as proof that no cash was returned. `checkTarget` or supplier webhook
redelivery resumes the same evidence. External targets without a local refund request are not added
to the request-only background due scan; operators use the retained event and explicit target check.
The customer order projection independently includes durable successful journal facts.

## Plan orders

A plan purchase grants entitlement, not credits. It is refunded by paid amount through the same flow
(`totalCredits` 0: nothing is held or recovered). When the refunds of one payment reach its full paid
amount, the host calls the registered `paymentRefunded` fulfillment hooks once, in the settlement
transaction; the plan host revokes the term that payment defined (a partial refund keeps it). Without
such a hook the full refund of a plan sale writes a `billing.plan-refund-unapplied` outbox event.
