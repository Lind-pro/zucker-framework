# @zucker-framework/logging

## 1.0.19

### Patch Changes

- @zucker-framework/core@1.0.19

## 1.0.18

### Patch Changes

- @zucker-framework/core@1.0.18

## 1.0.17

### Patch Changes

- @zucker-framework/core@1.0.17

## 1.0.16

### Patch Changes

- @zucker-framework/core@1.0.16

## 1.0.15

### Patch Changes

- @zucker-framework/core@1.0.15

## 1.0.14

### Patch Changes

- @zucker-framework/core@1.0.14

## 1.0.13

### Patch Changes

- @zucker-framework/core@1.0.13

## 1.0.12

### Patch Changes

- @zucker-framework/core@1.0.12

## 1.0.11

### Patch Changes

- @zucker-framework/core@1.0.11

## 1.0.10

### Patch Changes

- Allow applications to disable HTTP request-parameter and response-body capture across
  decorated controllers and all audit sinks, even when a controller opts in. Existing
  capture behavior is unchanged when these options are omitted. The Server template uses
  metadata-only durable HTTP audit records to keep private configuration and content out
  of independently authorized log views.
- Route public package-root imports and requires to the existing matching ESM/CJS runtime and type artifacts. Previously, native ESM imports of these packages fell back to their CommonJS main entry, mixing auth/core provider classes with an application's ESM instances and breaking Nest dependency injection. Keep package.json metadata readable and preserve the existing main/module artifacts.

  Add a native Node regression for both module formats that checks package resolution, shared auth/guard identity and an Admin/Nest composition using a synthetic memory adapter. This does not make mixed import/require copies of a dual package interchangeable and does not replace persistent consumer validation. No service implementation, guard registration or access policy is relaxed.

  Use the CommonJS default export for eventemitter2 in config, dictionary and logging, with an explicit injection token referencing the original constructor. This fixes native ESM loading while retaining the shared Nest event emitter; no dependency is bundled or duplicated.

- @zucker-framework/core@1.0.10

## 1.0.9

### Patch Changes

- Add optional HTTP completion observations and access/business persistence policies. Observe completed, rejected and aborted requests once, including streaming responses.
- Wait for bounded aggregate acknowledgement before access sampling; retain final HTTP failures and slow responses, and prevent duplicate rejection details. Existing configurations and persisted log schemas remain compatible.

## 1.0.8

### Patch Changes

- @zucker-framework/core@1.0.8

## 1.0.7

### Patch Changes

- @zucker-framework/core@1.0.7

## 1.0.6

### Patch Changes

- @zucker-framework/core@1.0.6

## 1.0.5

### Patch Changes

- Expose producer prewarming/error callbacks and worker retry budgets/stalled interval; avoid removed BullMQ 6 paused-count argument while reading legacy paused counts without mutation. Validate worker options before opening connections. Harden persistent log pagination, date ranges and bounded CSV queries before storage access.
- Updated dependencies
  - @zucker-framework/core@1.0.5

## 1.0.3

### Patch Changes

- Preserve the original HTTP exception when ValidationPipe messages contain objects. Record only the exception summary instead of throwing during log redaction or serializing submitted values.

## 1.0.2

### Patch Changes

- c0de08f: Add response formatting/server-error hooks to the existing HTTP exception filter, configurable correlation header/request-property mapping, and error/slow-request observation hooks on the HTTP logger. Extend the existing ErrorTracker with bounded fixed-window retention, fingerprints, redaction and first-occurrence policy. Consumers can directly configure shared mechanisms without response-object shims, local request-ID middleware, duplicate error interceptors or timer-based deduplication services. Default Framework behavior remains compatible.

  Host configuration can assign 5xx stack logging to its exception filter while the shared interceptor handles observation and 4xx warnings. Reporting and observation callbacks do not replace the original exception/response when they fail.

- c0de08f: Add database-backed access and operation log services for paginated queries, statistics, timelines, bounded deletion, retention and CSV export. Root configuration reuses the host database adapter and explicitly configures privacy policy, client-IP retention and persistence. The shared interceptor persists both log kinds without changing application success/failure semantics and preserves structured HTTP error messages.
- c0de08f: Add persistent AI model administration with encrypted/masked credentials, transactional default reassignment and host validation/cache hooks. Add constrained catalog controller factories and nested prompt rendering. Add a shared Nest/Winston system-log sink with database draining and configurable PostgreSQL operational metrics. Product fields, permissions, privacy, recipients, templates and infrastructure settings remain consumer configuration.
- c0de08f: Add root-configured persistence for rejected HTTP requests, including guard failures and missing routes, with explicit path exclusions and client-IP retention policy. Add an HTTP error interceptor that preserves normalized request IDs and separates 4xx warnings from server-error stack logging without mutating its host logger context. Export the existing template HTML-escaping primitive for product templates to reuse directly.
- c0de08f: Expose API_KEY_GUARD_OPTIONS as an optional Nest injection token so guards discovered on routes receive the configured policy through imported modules.

  Route application log writes through the shared sink lifecycle. Stop accepting Winston writes before shutdown, drain accepted logs once, and preserve sanitized late shutdown diagnostics without writing to an ended stream.

- Align all public Framework packages to the maintainer-selected 1.0.2 release and keep subsequent releases synchronized through a Changesets fixed group. Package dependencies and the CLI scaffold catalog follow the same version.

  This release consolidates the pending API migrations, including breaking auth and payment persistence contracts. Review docs/package-release-1.0.2.md before upgrading from 1.0.0 or 1.0.1.

- c0de08f: Extract consumer-independent cancellation scopes, per-chunk idle timeouts, bounded concurrency admission and timezone helpers; reuse cancellation in the AI adapter. Add signed browser-bound OAuth state, login audit with transactional counters, device parsing and configurable Passport guards. Authorization guards can deny provider errors and select a safe log identity without rewriting request.user.

  Add a validated HTTP query DTO without changing QueryParamEntity. MetadataLogService reuses log persistence for explicitly projected metadata. The optional ai/langchain entry captures call timing and usage without forcing LangChain on other AI consumers.

  Add the single-process task supervisor and temporary export artifact manager. Both preserve their process-local scheduling boundaries: neither introduces durable task storage, distributed leases or multi-executor safety. Consumers retain state transitions, ownership, retry eligibility, prompts, budgets, messages, retention schedules and output policy.

  Source migration only: new APIs, independent test sources and consumers are prepared; verification and immutable publication remain separate pending stages.

  Add durable recipient inbox operations and bounded verified object transfer; retain recipient constraints in updates, reject content collisions, keep dry runs read-only and verify uploaded object bytes before success.

- Updated dependencies [c0de08f]
- Updated dependencies [c0de08f]
- Updated dependencies [c0de08f]
- Updated dependencies [c0de08f]
- Updated dependencies
- Updated dependencies [c0de08f]
  - @zucker-framework/core@1.0.2

## 1.0.0

### Major Changes

- First stable public release under the @zucker-framework organization. Publish compiled JavaScript, public type declarations, required runtime assets and Apache-2.0 license materials without source maps.

### Patch Changes

- Add Apache-2.0 license files, framework attribution, bundled third-party notices,
  and public npm publishing metadata to every library. Validate these materials
  in package contents before upload and declare required and optional runtime dependencies.
