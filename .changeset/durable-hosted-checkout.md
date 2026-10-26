---
"@zucker-framework/payment": patch
---

Add a durable hosted-checkout workflow with frozen server-side catalog offers, ownership/account
binding, persistent create/capture claims, verified provider reconciliation and transactional
initial fulfillment, including a private immutable JSON snapshot of consumer entitlement policy.
Freeze separately validated public provider metadata for supported Stripe/Creem attribution;
reject reserved correlation overrides and unsupported PayPal metadata before external dispatch.
Add Stripe, PayPal and Creem catalog adapters with explicit capability and
payment-evidence boundaries; preserve the existing amount-based order/refund contracts.
Reject a known payable-amount mismatch before exposing a checkout URL, and include the
Stripe session return hint for owner-scoped, provider-verified unknown-outcome recovery.
