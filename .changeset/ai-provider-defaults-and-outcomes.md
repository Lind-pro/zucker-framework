---
'@zucker-framework/ai': minor
---

Expose LangChain provider protocol/endpoint/structured-output defaults through the existing optional LangChain entry. Unknown providers retain the OpenAI-compatible protocol without an assumed endpoint; callers keep explicit endpoint overrides and model/routing policy.

Expose a diagnostic failure-outcome classifier for cancellation, timeout and other errors. Keep the existing retry classifier unchanged so moving observation logic does not silently alter provider attempts.

Consumer source integration and regression sources are prepared. Tests, dependency synchronization and immutable publication remain pending.
