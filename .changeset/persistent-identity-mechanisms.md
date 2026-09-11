---
"@zucker-framework/auth": major
---

Add caller-transaction identity serialization, persistent verification-code and opaque one-time-ticket mechanisms, configurable OAuth binding persistence/locking, and native atomic permission imports. Permission import no longer falls back to find/create when upsert is unavailable and uses a unified synchronization success message. Configure an atomic persist callback for adapters without native upsert.

Verification requires an available authoritative attempt store and fails closed on cache degradation. Configure a per-user transaction lock for concurrent-safe final OAuth login-method removal. Product trust, account creation, TTLs, templates and claim payloads remain consumer policy. Independent test sources are supplied but were not executed during the consumer's verification pause.
