# Frontend shared contracts

`@zucker-framework/fe-types/back-office` (also re-exported from the root) is the back-office wire
contract of `docs/back-office-rfc.md` §8: plan/price, public plan, user subscription, quota and mail
log shapes (`TDate` is `string` on the wire and `Date` in server records), the status/cycle/interval
constants, and the single `PortErrorReason` with its HTTP status map. Domain errors are marked with
the registered `PORT_ERROR` symbol (`brandPortError`, `isPortError`), so admin translates only real
port errors; `readPortError(body)` reads both the raw error body and the common
`{ status, code, message, result }` envelope. The subpath has no dependencies, so backend packages
(`admin`, `payment`, `credit`) can share it without loading the schemas below.

This package exports frontend-safe types, runtime schemas and template-variable extraction. `redactFields(value, sensitiveFields, replacement?)` recursively copies JSON-like data, replacing explicitly selected keys without mutating the input. Field matching is case-sensitive; the default replacement is `[Redacted]`. Consumers retain sensitive-field lists and reporter hooks.

The redaction primitive has no Node, NestJS or backend dependencies. It expects JSON-like objects and arrays, matching error-report payloads. Its source contracts are in `src/redact-fields.spec.ts`; a new immutable release and consumer validation are required before adopting new exports from the registry.

`redactFields` now reuses `@zucker-framework/core/privacy`. `inspectUserAgent(ua)` and `UserAgentDetails` reuse `@zucker-framework/core/user-agent`, exposing nullable browser/OS/device details and desktop/mobile/tablet/bot classification. The application chooses labels, missing-value text and version display. These explicit Core entry points contain no Node dependencies; frontend code does not import the Core root.
