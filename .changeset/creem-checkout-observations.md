---
"@zucker-framework/payment": patch
---

Add a dependency-free Creem catalog Checkout adapter with explicit test/production configuration, raw-body HMAC webhook verification, read-only checkout/transaction/subscription observations, explicit cancellation, and the provider's supported full-remaining refund operation. Keep pending and unknown outcomes distinct, never invent payment amounts or refund receipt IDs, and do not automatically retry mutations.

Expose neutral subscription lifecycle/period/payment observations and a deterministic namespaced period key for consumer-owned transactional grant receipts. Document how existing order stores consume the hosted observations and why the catalog adapter is not a drop-in amount-based OrderService provider. No product pricing, entitlement policy, persistence migration or live payment calls are added.
