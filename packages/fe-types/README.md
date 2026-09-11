# Frontend shared contracts

This package exports frontend-safe types, runtime schemas and template-variable extraction. `redactFields(value, sensitiveFields, replacement?)` recursively copies JSON-like data, replacing explicitly selected keys without mutating the input. Field matching is case-sensitive; the default replacement is `[Redacted]`. Consumers retain sensitive-field lists and reporter hooks.

The redaction primitive has no Node, NestJS or backend dependencies. It expects JSON-like objects and arrays, matching error-report payloads. Its source contracts are in `src/redact-fields.spec.ts`; a new immutable release and consumer validation are required before adopting new exports from the registry.

`redactFields` now reuses `@zucker-framework/core/privacy`. `inspectUserAgent(ua)` and `UserAgentDetails` reuse `@zucker-framework/core/user-agent`, exposing nullable browser/OS/device details and desktop/mobile/tablet/bot classification. The application chooses labels, missing-value text and version display. These explicit Core entry points contain no Node dependencies; frontend code does not import the Core root.
