# @zucker-framework/fe-analytics

## 1.0.7

## 1.0.6

## 1.0.5

## 1.0.2

### Patch Changes

- c0de08f: Add configurable analytics headers, payload serialization and session identifiers so consumers can preserve authenticated single-event APIs while sharing keepalive delivery. Keep the default batch/beacon contract and fall back to fetch when a beacon cannot be queued.

  Export the authentication persistence hydration hook factory and local-redirect validation primitive. Product routes, locale rules, event schemas and identity/consent policies remain in consumers. These source changes require focused package and consumer validation before release.

  Export a Web Request/Response streaming proxy with explicit upstream selection and optional GET/HEAD transport retries. Preserve request cancellation, authentication headers and SSE response streaming without coupling to a consumer router or environment.

- Align all public Framework packages to the maintainer-selected 1.0.2 release and keep subsequent releases synchronized through a Changesets fixed group. Package dependencies and the CLI scaffold catalog follow the same version.

  This release consolidates the pending API migrations, including breaking auth and payment persistence contracts. Review docs/package-release-1.0.2.md before upgrading from 1.0.0 or 1.0.1.

## 1.0.0

### Major Changes

- First stable public release under the @zucker-framework organization. Publish compiled JavaScript, public type declarations, required runtime assets and Apache-2.0 license materials without source maps.

### Patch Changes

- Add Apache-2.0 license files, framework attribution, bundled third-party notices,
  and public npm publishing metadata to every library. Validate these materials
  in package contents before upload and declare required and optional runtime dependencies.
