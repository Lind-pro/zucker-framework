# @zucker-framework/credit

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

- Add opt-in transaction-bound credit lot holds with precise allocation, stable phase receipts and idempotent confirmation/release. Configured ledger consumption excludes held value, expiry preserves original allocation evidence while removing both free and frozen parts, and legacy unallocated freezing explicitly requires reconciliation.
- Expose transaction-bound expiry of selected owned credit lots so a host can fence expiry and its canonical journal with the task completion transaction. Existing expiry scanning reuses the same mechanism, including lots whose deadline equals the scan time.
- Route public package-root imports and requires to the existing matching ESM/CJS runtime and type artifacts. Previously, native ESM imports of these packages fell back to their CommonJS main entry, mixing auth/core provider classes with an application's ESM instances and breaking Nest dependency injection. Keep package.json metadata readable and preserve the existing main/module artifacts.

  Add a native Node regression for both module formats that checks package resolution, shared auth/guard identity and an Admin/Nest composition using a synthetic memory adapter. This does not make mixed import/require copies of a dual package interchangeable and does not replace persistent consumer validation. No service implementation, guard registration or access policy is relaxed.

  Use the CommonJS default export for eventemitter2 in config, dictionary and logging, with an explicit injection token referencing the original constructor. This fixes native ESM loading while retaining the shared Nest event emitter; no dependency is bundled or duplicated.

- @zucker-framework/core@1.0.10

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

- Add transaction-bound durable quota reservation transitions with stable-id conflict checking, idempotent confirmation/release, captured-policy charging, and expiry. Consumers supply persistence/locking ports and entitlement policy; no schema or product configuration is installed automatically.
- Updated dependencies
  - @zucker-framework/core@1.0.5

## 1.0.3

- Add `revokeUnused`: transaction-bound revocation of selected unused credit lots using the existing account lock and journal, for refunds that must take back unspent credits without touching consumed ones.

## 1.0.2

### Patch Changes

- c0de08f: Add transaction-bound batch credit grants, FIFO consumption with source restrictions and allocation records, balance/journal writes, and locked remaining-amount expiry. Adapt existing model/column/transaction ports and reuse the existing account lock/operation receipt coordinator without a new schema or memory state.

  Applications retain source/type values, eligibility, billing, metadata and error responses. Preferred sources cannot bypass allowed sources. Independent test sources are included but have not been executed during the consumer's verification pause.

- c0de08f: Add QuotaCapacity and its transaction-bound storage contract for shared quota checking and conditional consumption. Preserve existing usage when updating configured limits, count current unexpired and unknown-period legacy reservations conservatively, and surface capacity/input/persistence failures without business event or subscription policy.

  CNIPA maps its existing quota models and transaction lock, retaining plan lookup, cycle names and post-commit events. Its checks and consumption now use the same reservation semantics. No schema or data migration, provider operation, dependency installation or runtime verification was performed.

- Align all public Framework packages to the maintainer-selected 1.0.2 release and keep subsequent releases synchronized through a Changesets fixed group. Package dependencies and the CLI scaffold catalog follow the same version.

  This release consolidates the pending API migrations, including breaking auth and payment persistence contracts. Review docs/package-release-1.0.2.md before upgrading from 1.0.0 or 1.0.1.

- Updated dependencies [c0de08f]
- Updated dependencies [c0de08f]
- Updated dependencies [c0de08f]
- Updated dependencies [c0de08f]
- Updated dependencies
- Updated dependencies [c0de08f]
  - @zucker-framework/core@1.0.2

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
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @zucker-framework/core@1.0.0
