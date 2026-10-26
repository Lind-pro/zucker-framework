---
"@zucker-framework/storage": patch
---

Add private file asset orchestration over existing verified object transfers, with consumer-owned durable metadata and authorization ports. Reserve scoped idempotency and immutable content before uploading, verify content before readiness, and recover interrupted metadata commits without rewriting verified objects.

Keep logical deletion separate from observed physical cleanup, retain tombstones, reject stale readiness commits, and make failed or late-arriving object cleanup retryable. Extend BufferedFileManagerStore with deletion. Database uniqueness/CAS and durable recovery scheduling remain explicit consumer integration requirements; no schema, production storage access or background worker is provisioned by the package.

Propagate local filesystem permission/unknown errors instead of treating them as absence or successful deletion.
