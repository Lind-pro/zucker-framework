---
"@zucker-framework/admin": patch
"@zucker-framework/dictionary": patch
---

Restore the default dictionary manager's persistent creation, item filtering and editing. Map
public item aliases to the existing text/ordinal/describe storage contract, preserve compatible
service inputs/outputs, and add permission-protected dictionary/item PUT endpoints with explicit
validation, not-found and conflict responses.
