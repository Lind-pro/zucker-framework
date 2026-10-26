---
"@zucker-framework/common": patch
---

Keep unknown HTTP exception diagnostics out of default logs. ORM and provider errors can embed
submitted data or credential hashes in their message and stack. Preserve the generic response and
the explicit onServerError hook for application-controlled, redacted diagnostics.
