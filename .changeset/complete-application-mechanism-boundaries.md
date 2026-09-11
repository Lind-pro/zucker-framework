---
'@zucker-framework/core': minor
'@zucker-framework/fe-types': minor
'@zucker-framework/auth': patch
'@zucker-framework/monitoring': minor
'@zucker-framework/notification': minor
'@zucker-framework/cli': patch
---

Centralize browser-safe field redaction and UA inspection in Core public subpaths; keep existing auth and frontend exports backed by those implementations. Add an optional, explicitly configured Sentry adapter, health-check subsets that fail closed when probes are absent, and reusable mail/webhook provider probes. Reuse webhook transport with injectable fetch, redirect policy and typed delivery errors. Add the runtime-template safe link primitive.

Applications retain routes, business queries, thresholds, field selections, SDK configuration, locale labels, external-call authorization and message content. Sources and independent tests are prepared; verification and immutable release remain pending.
