---
"@zucker-framework/notification": minor
"@zucker-framework/admin": minor
---

Add root-configured mail delivery and a database-backed localized template catalog. Reuse existing template parsing, provider adapters and host database connections. Preserve provider-native idempotency, cancellation, queue rate slots, final delivery history, locale fallback and host-owned template/preview/tracking policies. Extend email providers with complete envelopes and provider receipts; encode binary Resend attachments correctly. Add configurable template-management controllers with separate read/write permissions.

Move mail history, atomic PostgreSQL engagement statistics, Svix callback verification and single-worker campaign orchestration into shared services. Await interrupted-campaign recovery before registering the worker, preserve atomic claims, and mark queue-add failures explicitly. Batch delivery retains bounded concurrency/deduplication and daily-quota stopping. Host callbacks own audience and suppression policies.
