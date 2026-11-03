# @zucker-framework/crud

## 1.0.12

### Patch Changes

- @zucker-framework/cache@1.0.12
  - @zucker-framework/core@1.0.12
  - @zucker-framework/event@1.0.12

## 1.0.11

### Patch Changes

- @zucker-framework/cache@1.0.11
  - @zucker-framework/core@1.0.11
  - @zucker-framework/event@1.0.11

## 1.0.10

### Patch Changes

- Updated dependencies
  - @zucker-framework/cache@1.0.10
  - @zucker-framework/core@1.0.10
  - @zucker-framework/event@1.0.10

## 1.0.9

### Patch Changes

- Add opt-in SELECT-first total inference and public `resolvePageTotal` for custom transactional queries.
- Export `withActiveRecordWhere` and enforce active-record conditions across SoftDeleteService reads, writes, batches, query builders and transaction callbacks.
- Ordinary writes cannot change `deletedAt`; use lifecycle methods. Bulk deletion now retains records, and explicit force deletion supports retained rows. See README for adapter and migration requirements.

## 1.0.8

### Patch Changes

- @zucker-framework/cache@1.0.8
  - @zucker-framework/core@1.0.8
  - @zucker-framework/event@1.0.8

## 1.0.7

### Patch Changes

- @zucker-framework/cache@1.0.7
  - @zucker-framework/core@1.0.7
  - @zucker-framework/event@1.0.7

## 1.0.6

### Patch Changes

- @zucker-framework/cache@1.0.6
  - @zucker-framework/core@1.0.6
  - @zucker-framework/event@1.0.6

## 1.0.5

### Patch Changes

- Updated dependencies
  - @zucker-framework/core@1.0.5
  - @zucker-framework/cache@1.0.5
  - @zucker-framework/event@1.0.5

## 1.0.2

### Patch Changes

- c0de08f: Add CrudEntity and an undecorated CrudService for services with custom Nest constructor layouts. Existing BaseService injection remains supported, and both entries share the same CRUD implementation. Allow BaseController consumers to select routes, configure HTTP methods/paths and decorators, and supply a validated query DTO. Single-record upsert is opt-in. This removes consumer-side metadata overrides without expanding their HTTP surface.
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
- Updated dependencies
- Updated dependencies [c0de08f]
- Updated dependencies [c0de08f]
- Updated dependencies
- Updated dependencies [c0de08f]
  - @zucker-framework/cache@1.0.2
  - @zucker-framework/core@1.0.2
  - @zucker-framework/event@1.0.2

## 1.0.1

### Patch Changes

- Declare cache/event peers required where the public entry imports their runtime
  tokens unconditionally. This fixes missing modules when consumers install auth,
  crud or rule-engine without the rest of the monorepo. Refresh the CLI scaffold
  catalog so newly generated server projects include the required cache package.
  Refresh credit's packed development dependency metadata for the new CRUD version
  without rebuilding different metadata under an already published credit version.

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
- Updated dependencies
  - @zucker-framework/cache@1.0.0
  - @zucker-framework/core@1.0.0
  - @zucker-framework/event@1.0.0
