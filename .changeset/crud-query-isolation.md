---
"@zucker-framework/crud": patch
---

Add opt-in SELECT-first page totals and export resolvePageTotal for custom transactional queries. Export withActiveRecordWhere and enforce active-record fences across SoftDeleteService reads and writes. Generic writes cannot change deletedAt; use explicit lifecycle methods. CNIPA consumes the primitives inside its existing transaction and retention policies.
