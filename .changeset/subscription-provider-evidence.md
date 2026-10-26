---
"@zucker-framework/payment": patch
---

Add provider subscription protocols for Stripe, Creem and PayPal, with paginated actual-money
receipts, explicit provider-period evidence, verified lifecycle webhook correlation, cancel-and-read
behavior, supported customer portal/invoice operations and capability declarations. Extend PayPal
hosted checkout to existing fixed-price subscription plans with durable creation keys and initial
transaction reconciliation. PayPal per-payment evidence remains distinct from service-period proof;
applications must explicitly choose entitlement policy or provide durable period receipts.
