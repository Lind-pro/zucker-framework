---
'@zucker-framework/payment': patch
---

Use the subscription invoice as the hosted checkout receipt even when Stripe also supplies its payment intent, keeping the initial purchase aligned with renewal fulfillment. Incomplete subscription invoice evidence remains unresolved instead of binding a different payment identity.
