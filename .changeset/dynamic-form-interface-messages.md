---
"@zucker-framework/fe-form": patch
"@zucker-framework/cli": patch
---

Allow each dynamic form to supply localized interface and fallback validation text without changing
caller-owned field content, discarding drafts, or changing the default language for existing callers.
The Admin template supplies its active Chinese/English copy to form previews.
