# Frontend consumer consolidation

Product-neutral mechanisms now live in Framework packages; consumers keep domain rules and application configuration.

- **fe-http-client** exports `HttpClient`, `createCookieRefresh`, `BaseService` and its query/response types. CRUD retains configurable operator/date/read-only fields and legacy transport behavior. Cookie refresh accepts an endpoint, sends credentials, validates the access-token response and returns only the access token. Applications choose their endpoint and response-error UX.
- **fe-auth** accepts a user type parameter, persistence options before hydration, a permission matcher and before/after logout hooks. Logout clears auth state even if consumer cleanup fails. HttpOnly consumers omit refresh tokens from their persistence selection. The default token-based store behavior remains available.
- **fe-permission** consumes the permission slice of an auth store, allowing typed user stores without requiring their user shape.
- **fe-storage** preserves its JSON/key API and treats SSR, blocked storage and quota failures as best-effort operations. Reads return empty fallbacks; storage failures do not throw from auth cleanup.
- **media** exports Mermaid sanitization, structural validation, state/sequence layout and `renderMermaidSvg` beside image/SVG utilities. Rendering lazily imports its optional Mermaid peer. Consumers that render install Mermaid; backend users of only image/sanitization utilities do not need it. Existing diagram source is preserved separately from layout-only adjustments.
- **fe-types** exports template variable extraction for `{{word}}` placeholders. Templates, recipients and product variable definitions remain in consumers.

The diagram extraction has a concrete security/reliability purpose: untrusted diagram content is normalized consistently, and serialized access to Mermaid's global renderer prevents concurrent configuration from mixing between display/export calls. It contains no product schema or task names.

Local validation covers package unit contracts, public development exports, consumer types and runtime flows. CNIPA directly consumes these APIs through its existing source-development workflow; there is no deferred patch or local duplicate implementation. These additions require a new immutable package release before downstream CI/production can consume them from npm. Publication is not part of local development validation.
