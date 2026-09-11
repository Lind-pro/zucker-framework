---
"@zucker-framework/credit": minor
---

Add transaction-bound batch credit grants, FIFO consumption with source restrictions and allocation records, balance/journal writes, and locked remaining-amount expiry. Adapt existing model/column/transaction ports and reuse the existing account lock/operation receipt coordinator without a new schema or memory state.

Applications retain source/type values, eligibility, billing, metadata and error responses. Preferred sources cannot bypass allowed sources. Independent test sources are included but have not been executed during the consumer's verification pause.
