---
"@zucker-framework/common": patch
---

Pass Nest StreamableFile responses through the response interceptor unchanged. Add an optional rejectOnError mode to pLimit that rejects the original failure and stops dispatching queued work, while preserving error-as-result behavior by default.
