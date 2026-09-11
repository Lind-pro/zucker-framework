---
'@zucker-framework/payment': major
---

Require explicit asynchronous order persistence and remove the OrderService in-memory store. Export OrderPersistence and DatabaseOrderPersistence over the existing database model port, including one-statement conditional state updates without money/JSON/date conversion or implicit transaction creation.

Make formerly synchronous order/recovery reads and cancellation asynchronous. Claim confirmation/refund transitions before provider calls; retain unknown outcomes, including pending/processing confirmation responses, for reconciliation rather than automatically issuing another charge. Preserve refunded confirmation results as terminal. Surface provider-link persistence failures. ZuckerPaymentModule requires orderPersistence.

Replace in-memory recovery counts with a required atomic RecoveryAttemptStore contract when sending recovery mail. Reserve before sending, forward a stable attempt idempotency key and propagate persistence failure. There is no default recovery table or memory fallback.

CNIPA consumes the public persistence contract on its existing PostgreSQL order model and transaction clients. Product states, prices, records and fulfillment remain consumer policy. Regression and PostgreSQL contract sources are prepared but verification, dependency integration and publication remain pending.
