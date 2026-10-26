---
"@zucker-framework/logging": patch
---

Allow applications to disable HTTP request-parameter and response-body capture across
decorated controllers and all audit sinks, even when a controller opts in. Existing
capture behavior is unchanged when these options are omitted. The Server template uses
metadata-only durable HTTP audit records to keep private configuration and content out
of independently authorized log views.
