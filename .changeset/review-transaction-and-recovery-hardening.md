---
"@zucker-framework/admin": patch
"@zucker-framework/ai": patch
"@zucker-framework/ai-tasks": patch
"@zucker-framework/auth": patch
"@zucker-framework/back-office": patch
"@zucker-framework/buffer": patch
"@zucker-framework/cache": patch
"@zucker-framework/cli": patch
"@zucker-framework/crud": patch
"@zucker-framework/fe-auth": patch
"@zucker-framework/payment": patch
---

Harden account revocation, transactional credential changes, payment-history replay,
AI task recovery, cache sequence ordering, dynamic transaction reads, browser session
isolation, CLI execution and streamed output cleanup after the 1.0.18–1.0.21 review.

Admin user policies may run in the mutation transaction through `userChanging` and
`userRolesChanging` (including validated role expiries). Consumers retain policy names
and must use the supplied transaction and a consistent lock order. Credential hooks
must migrate from post-commit-only `sensitiveFieldsChanged` to
`sensitiveFieldsChanging(change, tx)`; required revocation writes commit atomically.

Direct permission replacement removes legacy untyped links by their stored IDs,
so consumers with a required grant-type field do not receive an invalid null filter.
Other grant types remain outside that replacement.

Custom authentication caches must support atomic sequence advancement/reads. Redis
sequence values are returned as decimal strings before safe-integer validation to
avoid RESP integer rounding at the JavaScript boundary.

AI task consumers must apply the supplied expand-only execution-checkpoint migration
and coordinate worker cutover. Unknown prior submissions are not automatically sent
again. Payment history must be retained with the ledger; automatic refunds fail closed
when the historical application evidence needed to restore entitlements is absent.

These patch-version contract changes require consumer migration and verification;
source-level tests do not replace installation of the final immutable release.
