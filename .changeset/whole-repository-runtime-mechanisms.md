---
"@zucker-framework/core": minor
"@zucker-framework/common": minor
"@zucker-framework/auth": minor
"@zucker-framework/ai": minor
"@zucker-framework/crud": minor
"@zucker-framework/logging": minor
"@zucker-framework/task": minor
"@zucker-framework/io": minor
"@zucker-framework/notification": minor
"@zucker-framework/storage": minor
---

Extract consumer-independent cancellation scopes, per-chunk idle timeouts, bounded concurrency admission and timezone helpers; reuse cancellation in the AI adapter. Add signed browser-bound OAuth state, login audit with transactional counters, device parsing and configurable Passport guards. Authorization guards can deny provider errors and select a safe log identity without rewriting request.user.

Add a validated HTTP query DTO without changing QueryParamEntity. MetadataLogService reuses log persistence for explicitly projected metadata. The optional ai/langchain entry captures call timing and usage without forcing LangChain on other AI consumers.

Add the single-process task supervisor and temporary export artifact manager. Both preserve their process-local scheduling boundaries: neither introduces durable task storage, distributed leases or multi-executor safety. Consumers retain state transitions, ownership, retry eligibility, prompts, budgets, messages, retention schedules and output policy.

Source migration only: new APIs, independent test sources and consumers are prepared; verification and immutable publication remain separate pending stages.

Add durable recipient inbox operations and bounded verified object transfer; retain recipient constraints in updates, reject content collisions, keep dry runs read-only and verify uploaded object bytes before success.
