---
"@zucker-framework/payment": minor
---

Expose explicitly configured Stripe client/signature primitives and PayPal SDK/OAuth/webhook/refund transport. Keep the generic PaymentProvider interface unchanged; consumer order, product, amount/currency, entitlement and fulfillment policies remain outside Framework. Stripe and PayPal SDKs are optional peers, loaded on use without upgrading the consumer's versions.
