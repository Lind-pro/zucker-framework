# @zucker-framework/ai

## 1.0.3

### Patch Changes

- Add experimental provider model discovery for OpenAI-compatible, Anthropic and Gemini catalogues, including configured proxies, bounded pagination and credential-safe failures. Expose saved-credential discovery through AIModelCatalogService without returning secrets.

## 1.0.2

### Patch Changes

- c0de08f: Add explicit LangChain chat/embedding construction, text stream collection, structured execution and strict schema postprocessing through public AI entry points. Keep provider routing, chat retry count, recovery prompts/budgets and optional array-root mapping caller-controlled. SDKs remain lazy; idle/cancel failures bypass parser recovery.

  Add a lazy coalesced AI access client session with one provider attempt per explicit invocation and awaited outcome observers. Failed initialization can recover on a later request without automatically retrying provider work.

- c0de08f: Expose LangChain provider protocol/endpoint/structured-output defaults through the existing optional LangChain entry. Unknown providers retain the OpenAI-compatible protocol without an assumed endpoint; callers keep explicit endpoint overrides and model/routing policy.

  Expose a diagnostic failure-outcome classifier for cancellation, timeout and other errors. Keep the existing retry classifier unchanged so moving observation logic does not silently alter provider attempts.

  Consumer source integration and regression sources are prepared. Tests, dependency synchronization and immutable publication remain pending.

- c0de08f: Add graph update consumption to the public AI LangChain entry and support full message histories, reply whitespace policy and usage metadata in its text collector. Existing prompt callers retain trimmed output.

  Add a single-execution heartbeat scope with serial heartbeats, typed heartbeat failure, caller cancellation forwarding and cleanup. It has no lease, worker or persistence policy.

  Add subscription-based SSE with serialized asynchronous transforms, terminal delivery, snapshot and disconnect cleanup. Disconnecting this stream never cancels the producer.

- c0de08f: Add persistent AI model administration with encrypted/masked credentials, transactional default reassignment and host validation/cache hooks. Add constrained catalog controller factories and nested prompt rendering. Add a shared Nest/Winston system-log sink with database draining and configurable PostgreSQL operational metrics. Product fields, permissions, privacy, recipients, templates and infrastructure settings remain consumer configuration.
- Align all public Framework packages to the maintainer-selected 1.0.2 release and keep subsequent releases synchronized through a Changesets fixed group. Package dependencies and the CLI scaffold catalog follow the same version.

  This release consolidates the pending API migrations, including breaking auth and payment persistence contracts. Review docs/package-release-1.0.2.md before upgrading from 1.0.0 or 1.0.1.

- c0de08f: Extract consumer-independent cancellation scopes, per-chunk idle timeouts, bounded concurrency admission and timezone helpers; reuse cancellation in the AI adapter. Add signed browser-bound OAuth state, login audit with transactional counters, device parsing and configurable Passport guards. Authorization guards can deny provider errors and select a safe log identity without rewriting request.user.

  Add a validated HTTP query DTO without changing QueryParamEntity. MetadataLogService reuses log persistence for explicitly projected metadata. The optional ai/langchain entry captures call timing and usage without forcing LangChain on other AI consumers.

  Add the single-process task supervisor and temporary export artifact manager. Both preserve their process-local scheduling boundaries: neither introduces durable task storage, distributed leases or multi-executor safety. Consumers retain state transitions, ownership, retry eligibility, prompts, budgets, messages, retention schedules and output policy.

  Source migration only: new APIs, independent test sources and consumers are prepared; verification and immutable publication remain separate pending stages.

  Add durable recipient inbox operations and bounded verified object transfer; retain recipient constraints in updates, reject content collisions, keep dry runs read-only and verify uploaded object bytes before success.

- Updated dependencies [c0de08f]
- Updated dependencies [c0de08f]
- Updated dependencies [3a5d2e2]
- Updated dependencies [c0de08f]
- Updated dependencies [c0de08f]
- Updated dependencies [c0de08f]
- Updated dependencies [c0de08f]
- Updated dependencies [c0de08f]
- Updated dependencies [c0de08f]
- Updated dependencies [c0de08f]
- Updated dependencies
- Updated dependencies [c0de08f]
  - @zucker-framework/ai-access@1.0.2
  - @zucker-framework/common@1.0.2
  - @zucker-framework/core@1.0.2

## 1.0.0

### Major Changes

- First stable public release under the @zucker-framework organization. Publish compiled JavaScript, public type declarations, required runtime assets and Apache-2.0 license materials without source maps.

### Minor Changes

- Add a trusted-automation Codex subscription provider with an official `codex exec` driver, ephemeral structured runs, least-privilege permission profiles, isolated child environments, cancellation and timeout handling. Keep the direct ChatGPT Responses transport as an explicitly experimental compatibility path.
- Add priority-ordered AI configuration sources for environment values, remote APIs, databases, and static configuration while preserving the existing database adapter fallback.

### Patch Changes

- Add Apache-2.0 license files, framework attribution, bundled third-party notices,
  and public npm publishing metadata to every library. Validate these materials
  in package contents before upload and declare required and optional runtime dependencies.
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @zucker-framework/ai-access@1.0.0
  - @zucker-framework/core@1.0.0
