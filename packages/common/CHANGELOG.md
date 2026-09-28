# @zucker-framework/common

## 1.0.6

### Patch Changes

- @zucker-framework/core@1.0.6

## 1.0.5

### Patch Changes

- Add cancellation deadline ref control, public synchronous/FIFO concurrency leases, non-mutating injectable-RNG shuffle, drain-on-error task mapping, immediate/configurable HTTP disconnect cancellation, and request-aggregate bounded Multer-compatible memory storage.

  Make WebDAV uploads/downloads truly streaming with cancellation/error teardown, directory stat rejection, shallow directory-inclusive listing, public ensureDirectory and explicit anonymous configuration policy. Correct FileManager's download stream type from fs.ReadStream to Node Readable (a breaking public type correction); upload accepts Readable. Hosts retain paths, ownership and disk recovery policy. Local/S3 buffering behavior is unchanged.

- Updated dependencies
  - @zucker-framework/core@1.0.5

## 1.0.3

### Patch Changes

- Add `parseJsonWithArrayRecovery(raw, arrayKey)` to retain complete object entries from a truncated top-level JSON array without completing partial values. Preserve preceding fields, reject malformed or ambiguous recovery input, and leave existing JSON parsing and repair APIs unchanged. Consumers retain schema validation and partial-result policy.
- Publish this additive API as a scoped patch at the maintainer's explicit request.

## 1.0.2

### Patch Changes

- 3a5d2e2: Pass Nest StreamableFile responses through the response interceptor unchanged. Add an optional rejectOnError mode to pLimit that rejects the original failure and stops dispatching queued work, while preserving error-as-result behavior by default.
- c0de08f: Add graph update consumption to the public AI LangChain entry and support full message histories, reply whitespace policy and usage metadata in its text collector. Existing prompt callers retain trimmed output.

  Add a single-execution heartbeat scope with serial heartbeats, typed heartbeat failure, caller cancellation forwarding and cleanup. It has no lease, worker or persistence policy.

  Add subscription-based SSE with serialized asynchronous transforms, terminal delivery, snapshot and disconnect cleanup. Disconnecting this stream never cancels the producer.

- c0de08f: Add response formatting/server-error hooks to the existing HTTP exception filter, configurable correlation header/request-property mapping, and error/slow-request observation hooks on the HTTP logger. Extend the existing ErrorTracker with bounded fixed-window retention, fingerprints, redaction and first-occurrence policy. Consumers can directly configure shared mechanisms without response-object shims, local request-ID middleware, duplicate error interceptors or timer-based deduplication services. Default Framework behavior remains compatible.

  Host configuration can assign 5xx stack logging to its exception filter while the shared interceptor handles observation and 4xx warnings. Reporting and observation callbacks do not replace the original exception/response when they fail.

- c0de08f: Expose configurable access and operation log management controllers backed by the shared persistent logging services. Hosts select routes, permission resources and audit labels while reusing pagination, statistics, timelines, bounded deletion and retention endpoints.

  Add read-only record controllers with allowlisted equality filters compatible with the frontend query encoding, and shared log query/CSV controllers. Export an RFC 5987 attachment-header formatter with an escaped ASCII fallback.

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
- Harden framework runtime packaging and public error handling, add controller and global-guard registration controls, unify the database adapter token, bound monitoring samples, expose portable metrics and uptime helpers, redact email delivery logs, and protect rate-limit storage keys.
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @zucker-framework/core@1.0.0
