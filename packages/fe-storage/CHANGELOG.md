# @zucker-framework/fe-storage

## 1.0.19

## 1.0.18

## 1.0.17

## 1.0.16

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

- Preserve HTTP transport evidence and decode bounded binary JSON errors, clear stale login-page identity, honor explicit raw JSON responses, and keep stream/refresh cancellation separate from authentication failures. Cancel SSE readers on consumer failures and apply normal status handling to refreshed streams.

  Add SSR-safe browser-readable cookie helpers with explicit consumer lifetime/scope policy, encoded values, and validated cookie names and attributes.

## 1.0.2

### Patch Changes

- c0de08f: Use a storage adapter's typed auth setters when available, preserving generic key/value adapters. Synchronize hydrated sessions with the HTTP client's token storage and retain consumer hydration callbacks. Accept typed user profiles in LocalStore without requiring an index signature.
- c0de08f: Add an explicit browser Blob download helper with object URL and temporary anchor cleanup. Consumers continue to choose filenames and when to trigger the download; HTTP transport remains separate.
- c0de08f: Add reusable client CRUD, typed auth stores with consumer logout/permission hooks, best-effort browser storage, portable Mermaid sanitization/layout/rendering, and shared template placeholders.
- Align all public Framework packages to the maintainer-selected 1.0.2 release and keep subsequent releases synchronized through a Changesets fixed group. Package dependencies and the CLI scaffold catalog follow the same version.

  This release consolidates the pending API migrations, including breaking auth and payment persistence contracts. Review docs/package-release-1.0.2.md before upgrading from 1.0.0 or 1.0.1.

## 1.0.0

### Major Changes

- First stable public release under the @zucker-framework organization. Publish compiled JavaScript, public type declarations, required runtime assets and Apache-2.0 license materials without source maps.

### Patch Changes

- Add Apache-2.0 license files, framework attribution, bundled third-party notices,
  and public npm publishing metadata to every library. Validate these materials
  in package contents before upload and declare required and optional runtime dependencies.
