---
"@zucker-framework/credit": patch
---

Add opt-in transaction-bound credit lot holds with precise allocation, stable phase receipts and idempotent confirmation/release. Configured ledger consumption excludes held value, expiry preserves original allocation evidence while removing both free and frozen parts, and legacy unallocated freezing explicitly requires reconciliation.
