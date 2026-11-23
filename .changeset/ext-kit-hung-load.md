---
"@zucker-framework/ext-kit": patch
---

Batch capture no longer fails with "Page load timeout" when a parsed page keeps a request open forever (a hung tracker, font or analytics host). The content is captured after a 10 second grace period with a warning, and later readiness checks for the same page do not wait the grace again.
