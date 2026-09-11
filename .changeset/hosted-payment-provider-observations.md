---
"@zucker-framework/payment": minor
---

Expose hosted Checkout and payment-intent operations with raw provider results and normalized settlement, expandable resource IDs and payment-method evidence. Add PayPal order creation/capture/read observations and verified-webhook payload decoding with required capture identity.

Provider reads remain read-only. Nonterminal/approved evidence stays unknown; only an explicit capture operation charges. Requests, SDK versions, product metadata, currency/price policy, redirects and fulfillment remain owned by the consumer. No refund activation or storage migration is included.
