# @zucker-framework/core

## 1.0.15

## 1.0.14

## 1.0.13

## 1.0.12

## 1.0.11

## 1.0.10

## 1.0.8

## 1.0.7

## 1.0.6

## 1.0.5

### Patch Changes

- Add cancellation deadline ref control, public synchronous/FIFO concurrency leases, non-mutating injectable-RNG shuffle, drain-on-error task mapping, immediate/configurable HTTP disconnect cancellation, and request-aggregate bounded Multer-compatible memory storage.

  Make WebDAV uploads/downloads truly streaming with cancellation/error teardown, directory stat rejection, shallow directory-inclusive listing, public ensureDirectory and explicit anonymous configuration policy. Correct FileManager's download stream type from fs.ReadStream to Node Readable (a breaking public type correction); upload accepts Readable. Hosts retain paths, ownership and disk recovery policy. Local/S3 buffering behavior is unchanged.

## 1.0.2

### Patch Changes

- c0de08f: Centralize browser-safe field redaction and UA inspection in Core public subpaths; keep existing auth and frontend exports backed by those implementations. Add an optional, explicitly configured Sentry adapter, health-check subsets that fail closed when probes are absent, and reusable mail/webhook provider probes. Reuse webhook transport with injectable fetch, redirect policy and typed delivery errors. Add the runtime-template safe link primitive.

  Applications retain routes, business queries, thresholds, field selections, SDK configuration, locale labels, external-call authorization and message content. Sources and independent tests are prepared; verification and immutable release remain pending.

- c0de08f: Add product-neutral immutable image manifest parsing, complete-set merging and source/run/repository/digest verification. Consumers configure component repositories and retain filesystem, CLI, environment and deployment policy. These functions do not query registries, build or publish images.
- c0de08f: Add root-configured persistence for rejected HTTP requests, including guard failures and missing routes, with explicit path exclusions and client-IP retention policy. Add an HTTP error interceptor that preserves normalized request IDs and separates 4xx warnings from server-error stack logging without mutating its host logger context. Export the existing template HTML-escaping primitive for product templates to reuse directly.
- c0de08f: Add SecretCipher for AES-256-GCM/scrypt encrypted fields with explicit key material, stable v2 encoding and opt-in read-only legacy CBC support. Require full GCM authentication tags and reject malformed/plaintext stored values. Add ScryptEncoder implementing PasswordEncoder while preserving the two-part hex salt/derived-key format. Application environment, key selection and accepted historical formats remain consumer configuration; no data rewrite or password reset is required for valid existing records.
- Align all public Framework packages to the maintainer-selected 1.0.2 release and keep subsequent releases synchronized through a Changesets fixed group. Package dependencies and the CLI scaffold catalog follow the same version.

  This release consolidates the pending API migrations, including breaking auth and payment persistence contracts. Review docs/package-release-1.0.2.md before upgrading from 1.0.0 or 1.0.1.

- c0de08f: Extract consumer-independent cancellation scopes, per-chunk idle timeouts, bounded concurrency admission and timezone helpers; reuse cancellation in the AI adapter. Add signed browser-bound OAuth state, login audit with transactional counters, device parsing and configurable Passport guards. Authorization guards can deny provider errors and select a safe log identity without rewriting request.user.

  Add a validated HTTP query DTO without changing QueryParamEntity. MetadataLogService reuses log persistence for explicitly projected metadata. The optional ai/langchain entry captures call timing and usage without forcing LangChain on other AI consumers.

  Add the single-process task supervisor and temporary export artifact manager. Both preserve their process-local scheduling boundaries: neither introduces durable task storage, distributed leases or multi-executor safety. Consumers retain state transitions, ownership, retry eligibility, prompts, budgets, messages, retention schedules and output policy.

  Source migration only: new APIs, independent test sources and consumers are prepared; verification and immutable publication remain separate pending stages.

  Add durable recipient inbox operations and bounded verified object transfer; retain recipient constraints in updates, reject content collisions, keep dry runs read-only and verify uploaded object bytes before success.

## 1.0.0

### Major Changes

- First stable public release under the @zucker-framework organization. Publish compiled JavaScript, public type declarations, required runtime assets and Apache-2.0 license materials without source maps.

### Patch Changes

- Add Apache-2.0 license files, framework attribution, bundled third-party notices,
  and public npm publishing metadata to every library. Validate these materials
  in package contents before upload and declare required and optional runtime dependencies.
- Disable source maps in package builds. Release checks now reject source maps,
  inline source map references and uncompiled TypeScript/JSX implementation files
  while retaining public type declarations and required runtime assets.
