# @zucker-framework/auth

## 1.0.16

### Patch Changes

- @zucker-framework/cache@1.0.16
  - @zucker-framework/core@1.0.16
  - @zucker-framework/crud@1.0.16

## 1.0.15

### Patch Changes

- @zucker-framework/cache@1.0.15
  - @zucker-framework/core@1.0.15
  - @zucker-framework/crud@1.0.15

## 1.0.14

### Patch Changes

- @zucker-framework/cache@1.0.14
  - @zucker-framework/core@1.0.14
  - @zucker-framework/crud@1.0.14

## 1.0.13

### Patch Changes

- @zucker-framework/cache@1.0.13
  - @zucker-framework/core@1.0.13
  - @zucker-framework/crud@1.0.13

## 1.0.12

### Patch Changes

- @zucker-framework/cache@1.0.12
  - @zucker-framework/core@1.0.12
  - @zucker-framework/crud@1.0.12

## 1.0.11

### Patch Changes

- @zucker-framework/cache@1.0.11
  - @zucker-framework/core@1.0.11
  - @zucker-framework/crud@1.0.11

## 1.0.10

### Patch Changes

- Add atomic owner-scoped renaming for active API keys, returning only safe name/id metadata while preserving secret, permissions and lifecycle state.
- Expose PersistentSessionRefreshTokenStore to bind the existing token-pair lifecycle to durable, independently revocable sessions without cache-miss resurrection. Add exact session lookup and active-session refresh initialization.

  The Server consumer template composes this API with public registration, hashed one-use verification/reset tickets, HttpOnly refresh cookies, owner-scoped sessions, credential-version invalidation and explicit administrator setup. The full template requires its own PostgreSQL migrations and mail configuration; no default administrator password is created on startup. This is local source integration, not a published artifact or a production migration.

- Add server-side Google ID-token verification with bounded JWKS caching and rotation, plus one-time OAuth login/linking proofs composed from existing ticket primitives. Reject browser-supplied third-party profiles at the generic binding endpoint: consumers must configure a verified binding-proof resolver or keep their own authenticated binding controller. Preserve the trusted low-level binding API and consumer-owned admission, ownership and transaction policies.
- Updated dependencies
  - @zucker-framework/cache@1.0.10
  - @zucker-framework/crud@1.0.10
  - @zucker-framework/core@1.0.10

## 1.0.8

### Patch Changes

- @zucker-framework/cache@1.0.8
  - @zucker-framework/core@1.0.8
  - @zucker-framework/crud@1.0.8

## 1.0.7

### Patch Changes

- @zucker-framework/cache@1.0.7
  - @zucker-framework/core@1.0.7
  - @zucker-framework/crud@1.0.7

## 1.0.6

### Patch Changes

- Require explicit related model names in UserService.deleteUser. Delete related userId records and the account on one transaction, propagating cleanup failures. Removes hard-coded optional tables and swallowed database errors; callers must supply their schema binding.
- @zucker-framework/cache@1.0.6
  - @zucker-framework/core@1.0.6
  - @zucker-framework/crud@1.0.6

## 1.0.5

### Patch Changes

- Add product-neutral refresh-pair issuer, verifier, identity-loader and atomic store ports, with a legacy string-JTI cache adapter, explicit missing-key policy, and refresh revocation tombstones. Provide an explicitly process-local lock for process-local caches without installing a persistence fallback.

  Retain TokenService revocation evidence after no-cache session removal and reject ambiguous JWT authorization headers before Passport/blacklist credential parsing can diverge. Preserve optional/local guard compatibility defaults and support explicit strict credential/error policies.

- Prevent same-password updates from persisting plaintext, preserve caller DTOs and omitted fields, and add an update-only user operation plus transactional role-binding replacement with consumer field mapping. Password encoders and account policy remain explicitly configurable.
- Updated dependencies
  - @zucker-framework/core@1.0.5
  - @zucker-framework/cache@1.0.5
  - @zucker-framework/crud@1.0.5

## 1.0.2

### Patch Changes

- c0de08f: Centralize browser-safe field redaction and UA inspection in Core public subpaths; keep existing auth and frontend exports backed by those implementations. Add an optional, explicitly configured Sentry adapter, health-check subsets that fail closed when probes are absent, and reusable mail/webhook provider probes. Reuse webhook transport with injectable fetch, redirect policy and typed delivery errors. Add the runtime-template safe link primitive.

  Applications retain routes, business queries, thresholds, field selections, SDK configuration, locale labels, external-call authorization and message content. Sources and independent tests are prepared; verification and immutable release remain pending.

- c0de08f: Add atomic owner-constrained session revocation and a typed JwtStrategyBase extension point for asynchronous product identity validation. Preserve the default JwtStrategy mapping and constructor. Consumers can configure PersistentSessionService and RefreshTokenCookie directly without local wrapper classes; session metadata, cookie names and TTL/cache policy remain application configuration.
- 740f109: Add persistent database-backed sessions with atomic refresh rotation and revocation, optional deny-only caching, and configurable HttpOnly refresh-cookie transport. Add a required ownership guard for JWT request.user consumers, reuse the existing OwnCreated handler with explicit grant fallback, and check ownership for detail reads instead of relying on collection filters.
- c0de08f: Add API-key issuance, SHA-256 lookup, atomic revocation-aware usage touch, owner-bound management and header-only authentication over the existing DatabaseAdapter. Prefixes, default scopes/quotas, model names and response messages remain explicit consumer options.

  Add atomic rate consumption with a per-subject cap to the configured limiter engine, reusing its Redis deadline and persistent memory insurance instead of per-key clients or read/write counters. Key generation returns the secret once; database and key formats require no migration. Adapter and consumer verification are required before release.

- c0de08f: **Breaking API changes in the maintainer-selected unified 1.0.2 release.** Review the migration requirements below before upgrading; the shared patch version does not imply backward compatibility for this entry.

  Add caller-transaction identity serialization, persistent verification-code and opaque one-time-ticket mechanisms, configurable OAuth binding persistence/locking, and native atomic permission imports. Permission import no longer falls back to find/create when upsert is unavailable and uses a unified synchronization success message. Configure an atomic persist callback for adapters without native upsert.

  Verification requires an available authoritative attempt store and fails closed on cache degradation. Configure a per-user transaction lock for concurrent-safe final OAuth login-method removal. Product trust, account creation, TTLs, templates and claim payloads remain consumer policy. Independent test sources are supplied but were not executed during the consumer's verification pause.

- c0de08f: Add SecretCipher for AES-256-GCM/scrypt encrypted fields with explicit key material, stable v2 encoding and opt-in read-only legacy CBC support. Require full GCM authentication tags and reject malformed/plaintext stored values. Add ScryptEncoder implementing PasswordEncoder while preserving the two-part hex salt/derived-key format. Application environment, key selection and accepted historical formats remain consumer configuration; no data rewrite or password reset is required for valid existing records.
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
- Updated dependencies [c0de08f]
- Updated dependencies [c0de08f]
- Updated dependencies
- Updated dependencies [c0de08f]
  - @zucker-framework/cache@1.0.2
  - @zucker-framework/core@1.0.2
  - @zucker-framework/crud@1.0.2

## 1.0.1

### Patch Changes

- Updated dependencies
  - @zucker-framework/crud@1.0.1

## 1.0.0

### Major Changes

- First stable public release under the @zucker-framework organization. Publish compiled JavaScript, public type declarations, required runtime assets and Apache-2.0 license materials without source maps.

### Minor Changes

- Harden framework runtime packaging and public error handling, add controller and global-guard registration controls, unify the database adapter token, bound monitoring samples, expose portable metrics and uptime helpers, redact email delivery logs, and protect rate-limit storage keys.

### Patch Changes

- Add Apache-2.0 license files, framework attribution, bundled third-party notices,
  and public npm publishing metadata to every library. Validate these materials
  in package contents before upload and declare required and optional runtime dependencies.
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @zucker-framework/cache@1.0.0
  - @zucker-framework/core@1.0.0
  - @zucker-framework/crud@1.0.0
