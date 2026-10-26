---
"@zucker-framework/admin": patch
"@zucker-framework/cli": patch
---

Validate user-role replacement input and serialize replacements through the owning user row before
deleting and inserting memberships. Concurrent replacements must not accidentally combine grants,
and failed writes retain the previous set. The Admin template exposes the existing assignment API
through an authorized, localized editor with isolated drafts and retryable failures.
