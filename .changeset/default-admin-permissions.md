---
"@zucker-framework/admin": patch
---

Require explicit read and mutation permissions on default administrative controllers instead of allowing every authenticated account. Separate user/role authorization from ordinary edits, reject nested role relation writes and privileged role changes without authorization, invalidate permission caches after binding changes, and prevent notification creation from overwriting an existing template without update permission. Public health and configurable controller factories retain their existing contracts. Existing delegated admin roles must be assigned the appropriate resource actions explicitly.
