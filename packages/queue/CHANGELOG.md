# @zucker-framework/queue

## 1.0.11

## 1.0.10

### Patch Changes

- Route public package-root imports and requires to the existing matching ESM/CJS runtime and type artifacts. Previously, native ESM imports of these packages fell back to their CommonJS main entry, mixing auth/core provider classes with an application's ESM instances and breaking Nest dependency injection. Keep package.json metadata readable and preserve the existing main/module artifacts.

  Add a native Node regression for both module formats that checks package resolution, shared auth/guard identity and an Admin/Nest composition using a synthetic memory adapter. This does not make mixed import/require copies of a dual package interchangeable and does not replace persistent consumer validation. No service implementation, guard registration or access policy is relaxed.

  Use the CommonJS default export for eventemitter2 in config, dictionary and logging, with an explicit injection token referencing the original constructor. This fixes native ESM loading while retaining the shared Nest event emitter; no dependency is bundled or duplicated.

## 1.0.8

## 1.0.7

## 1.0.6

## 1.0.5

### Patch Changes

- Expose native BullMQ count keys for compatible monitoring adapters; wait for all producer/worker closes before reporting aggregated shutdown failures, including synchronous throws. Keep document ZIP CRC validation compatible with Node 20 rather than introducing a Node 22-only default-entry import. Add explicit extension lifecycle and browser regression commands. These changes are unreleased; they do not authorize consumer source links or package publication.
- Expose producer prewarming/error callbacks and worker retry budgets/stalled interval; avoid removed BullMQ 6 paused-count argument while reading legacy paused counts without mutation. Validate worker options before opening connections. Harden persistent log pagination, date ranges and bounded CSV queries before storage access.

## 1.0.2

### Patch Changes

- Align all public Framework packages to the maintainer-selected 1.0.2 release and keep subsequent releases synchronized through a Changesets fixed group. Package dependencies and the CLI scaffold catalog follow the same version.

  This release consolidates the pending API migrations, including breaking auth and payment persistence contracts. Review docs/package-release-1.0.2.md before upgrading from 1.0.0 or 1.0.1.

## 1.0.0

### Major Changes

- First stable public release under the @zucker-framework organization. Publish compiled JavaScript, public type declarations, required runtime assets and Apache-2.0 license materials without source maps.

### Patch Changes

- Add Apache-2.0 license files, framework attribution, bundled third-party notices,
  and public npm publishing metadata to every library. Validate these materials
  in package contents before upload and declare required and optional runtime dependencies.
