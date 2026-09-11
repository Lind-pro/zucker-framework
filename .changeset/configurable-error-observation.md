---
"@zucker-framework/common": minor
"@zucker-framework/logging": minor
"@zucker-framework/monitoring": minor
---

Add response formatting/server-error hooks to the existing HTTP exception filter, configurable correlation header/request-property mapping, and error/slow-request observation hooks on the HTTP logger. Extend the existing ErrorTracker with bounded fixed-window retention, fingerprints, redaction and first-occurrence policy. Consumers can directly configure shared mechanisms without response-object shims, local request-ID middleware, duplicate error interceptors or timer-based deduplication services. Default Framework behavior remains compatible.

Host configuration can assign 5xx stack logging to its exception filter while the shared interceptor handles observation and 4xx warnings. Reporting and observation callbacks do not replace the original exception/response when they fail.
