# @zucker-framework/rate-limiter

## 1.0.2

### Patch Changes

- c0de08f: Add managed cache services with bounded Redis degradation, coalesced loads, mutation fencing, configurable memory capacity and explicit single-owner lifecycle. Preserve existing millisecond cache primitive contracts while exposing seconds/null service contracts for direct consumer adoption.

  Extend named rate limiters with managed Redis configuration, bounded operation deadlines, reusable in-process insurance, redacted recovery logging and idempotent ownership. Redis quota denials never fail open. Add an optional ioredis peer without changing existing limiter keys or the consume API. Consumers must configure roots once, retain business quotas and response policy locally, and verify isolated Redis failure/recovery before release. No schema migration is required.

- c0de08f: Add API-key issuance, SHA-256 lookup, atomic revocation-aware usage touch, owner-bound management and header-only authentication over the existing DatabaseAdapter. Prefixes, default scopes/quotas, model names and response messages remain explicit consumer options.

  Add atomic rate consumption with a per-subject cap to the configured limiter engine, reusing its Redis deadline and persistent memory insurance instead of per-key clients or read/write counters. Key generation returns the secret once; database and key formats require no migration. Adapter and consumer verification are required before release.

- Align all public Framework packages to the maintainer-selected 1.0.2 release and keep subsequent releases synchronized through a Changesets fixed group. Package dependencies and the CLI scaffold catalog follow the same version.

  This release consolidates the pending API migrations, including breaking auth and payment persistence contracts. Review docs/package-release-1.0.2.md before upgrading from 1.0.0 or 1.0.1.

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

### Minor Changes

- Harden framework runtime packaging and public error handling, add controller and global-guard registration controls, unify the database adapter token, bound monitoring samples, expose portable metrics and uptime helpers, redact email delivery logs, and protect rate-limit storage keys.

### Patch Changes

- Add Apache-2.0 license files, framework attribution, bundled third-party notices,
  and public npm publishing metadata to every library. Validate these materials
  in package contents before upload and declare required and optional runtime dependencies.
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @zucker-framework/core@1.0.0
