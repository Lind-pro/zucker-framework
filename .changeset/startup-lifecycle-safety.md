---
"@zucker-framework/auth": minor
"@zucker-framework/logging": patch
---

Expose API_KEY_GUARD_OPTIONS as an optional Nest injection token so guards discovered on routes receive the configured policy through imported modules.

Route application log writes through the shared sink lifecycle. Stop accepting Winston writes before shutdown, drain accepted logs once, and preserve sanitized late shutdown diagnostics without writing to an ended stream.
