---
'@zucker-framework/credit': minor
---

Add QuotaCapacity and its transaction-bound storage contract for shared quota checking and conditional consumption. Preserve existing usage when updating configured limits, count current unexpired and unknown-period legacy reservations conservatively, and surface capacity/input/persistence failures without business event or subscription policy.

CNIPA maps its existing quota models and transaction lock, retaining plan lookup, cycle names and post-commit events. Its checks and consumption now use the same reservation semantics. No schema or data migration, provider operation, dependency installation or runtime verification was performed.
