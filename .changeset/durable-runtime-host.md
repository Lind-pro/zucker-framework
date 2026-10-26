---
"@zucker-framework/task": patch
"@zucker-framework/notification": patch
---

Add optional host interruption to durable task attempts, preserving abandoned leases for recovery while draining in-flight heartbeats. Add a neutral PostgreSQL durable notification repository and schema with atomic enqueue, claims, lease fencing and expired-attempt recovery.
