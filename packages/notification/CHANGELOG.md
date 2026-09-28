# @zucker-framework/notification

## 1.0.6

### Patch Changes

- @zucker-framework/core@1.0.6
  - @zucker-framework/queue@1.0.6

## 1.0.5

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @zucker-framework/queue@1.0.5
  - @zucker-framework/core@1.0.5

## 1.0.2

### Patch Changes

- c0de08f: Centralize browser-safe field redaction and UA inspection in Core public subpaths; keep existing auth and frontend exports backed by those implementations. Add an optional, explicitly configured Sentry adapter, health-check subsets that fail closed when probes are absent, and reusable mail/webhook provider probes. Reuse webhook transport with injectable fetch, redirect policy and typed delivery errors. Add the runtime-template safe link primitive.

  Applications retain routes, business queries, thresholds, field selections, SDK configuration, locale labels, external-call authorization and message content. Sources and independent tests are prepared; verification and immutable release remain pending.

- c0de08f: Add root-configured mail delivery and a database-backed localized template catalog. Reuse existing template parsing, provider adapters and host database connections. Preserve provider-native idempotency, cancellation, queue rate slots, final delivery history, locale fallback and host-owned template/preview/tracking policies. Extend email providers with complete envelopes and provider receipts; encode binary Resend attachments correctly. Add configurable template-management controllers with separate read/write permissions.

  Move mail history, atomic PostgreSQL engagement statistics, Svix callback verification and single-worker campaign orchestration into shared services. Await interrupted-campaign recovery before registering the worker, preserve atomic claims, and mark queue-add failures explicitly. Batch delivery retains bounded concurrency/deduplication and daily-quota stopping. Host callbacks own audience and suppression policies.

- c0de08f: Add AlertNotificationService using the existing notification deduplication and Webhook transport. Provide DingTalk, WeCom, Slack and generic JSON alert envelopes, acknowledgement validation, delivery outcomes and shutdown draining. Make Webhook URLs absent from success logs because they may contain credentials. Fix zero-timestamp deduplication and expose cache size without another consumer cleanup timer. Destination/severity/fingerprint/redaction policy remains host configuration.
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
  - @zucker-framework/queue@1.0.2

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
