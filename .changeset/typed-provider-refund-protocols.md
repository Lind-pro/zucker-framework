---
"@zucker-framework/payment": patch
---

Add typed refund adapters for Stripe, PayPal and Creem using verified payment-kind identities and
actual decimal money. Support native full/partial refund commands, attributable Stripe invoice
funding, separate PayPal capture/sale protocols, refund queries and verified webhook evidence.
Expose explicit channel capabilities, scoped Stripe refund pagination, server command correlation,
separate cumulative refund totals and safe status-only/unknown outcomes. Keep provider IO and
protocols independent from consumer-owned refund permissions, durable command claims and ledger holds.
