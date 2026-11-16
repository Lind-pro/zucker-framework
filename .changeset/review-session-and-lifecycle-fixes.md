---
"@zucker-framework/fe-http-client": patch
"@zucker-framework/fe-auth": patch
"@zucker-framework/fe-admin": patch
"@zucker-framework/i18n": patch
"@zucker-framework/network": patch
"@zucker-framework/datasource": patch
"@zucker-framework/storage": patch
"@zucker-framework/provider": patch
"@zucker-framework/timeseries": patch
"@zucker-framework/rule-engine": patch
"@zucker-framework/tracing": patch
"@zucker-framework/cache": patch
---

Bind HTTP retries and cookie-session restoration to the originating session. Add the
optional HttpClientConfig.sessionKey callback and wire the admin consumer to its existing
identity policy. Cookie clients without a stable key conservatively cancel ambiguous
credential changes; retain request abort scopes for prompt cancellation.

Release Observable subscriptions and tracing spans on completion, failure and cancellation.
Dispose late network/datasource creations after lifecycle changes, roll back partially
started rule triggers, bind provider disposables to their registration, stream local upload
chunks with backpressure, preserve valid zero aggregations and cap all HybridCache L1 writes.

Network shutdown now waits for pending provider operations; providers must bound their I/O.
HybridCache L1 caps must be finite and non-negative; zero disables L1 population. Correct
legacy test typing without changing runtime exports or weakening assertions.
