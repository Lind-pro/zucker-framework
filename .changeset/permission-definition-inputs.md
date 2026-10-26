---
"@zucker-framework/admin": patch
---

Accept only permission-definition metadata in the create/update HTTP endpoints. Keep memberships
behind their dedicated authorization operations, reject unsupported fields before persistence, and
preserve the permission identifier during metadata edits.
