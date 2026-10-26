---
"@zucker-framework/admin": patch
---

Create and update a role's metadata and permission links in one transaction. Lock the role parent
before replacement or deletion, including empty permission sets, and evaluate sensitive changes
against the state read after that lock. Failed link writes now roll back metadata and new roles;
concurrent full replacements no longer combine grants.
