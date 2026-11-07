# @zucker-framework/fe-http-client

## 1.0.16

## 1.0.15

## 1.0.14

## 1.0.13

### Patch Changes

- Handle Codex oneOf schemas through prompt JSON with local validation and preserve authenticated sessions when token refresh encounters transient transport or service failures.

## 1.0.12

### Patch Changes

- Ignore canceled requests after asynchronously decoding binary error responses, so a stale response cannot clear a newer session or invoke error handlers.

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

- c0de08f: Add reusable client CRUD, typed auth stores with consumer logout/permission hooks, best-effort browser storage, portable Mermaid sanitization/layout/rendering, and shared template placeholders.
- c0de08f: Export error-message extraction that preserves server-response priority and supports string-array messages with an explicit consumer fallback and separator. Applications retain localized fallback text.
- c0de08f: Add configurable analytics headers, payload serialization and session identifiers so consumers can preserve authenticated single-event APIs while sharing keepalive delivery. Keep the default batch/beacon contract and fall back to fetch when a beacon cannot be queued.

  Export the authentication persistence hydration hook factory and local-redirect validation primitive. Product routes, locale rules, event schemas and identity/consent policies remain in consumers. These source changes require focused package and consumer validation before release.

  Export a Web Request/Response streaming proxy with explicit upstream selection and optional GET/HEAD transport retries. Preserve request cancellation, authentication headers and SSE response streaming without coupling to a consumer router or environment.

- d8b086d: Support HttpOnly-cookie refresh, single-flight and browser-lock coordination for renewal, structured response error hooks, and cancellation propagation. Preserve the existing explicit refresh-token flow.
- Align all public Framework packages to the maintainer-selected 1.0.2 release and keep subsequent releases synchronized through a Changesets fixed group. Package dependencies and the CLI scaffold catalog follow the same version.

  This release consolidates the pending API migrations, including breaking auth and payment persistence contracts. Review docs/package-release-1.0.2.md before upgrading from 1.0.0 or 1.0.1.

## 1.0.0

### Major Changes

- First stable public release under the @zucker-framework organization. Publish compiled JavaScript, public type declarations, required runtime assets and Apache-2.0 license materials without source maps.

### Minor Changes

- Add product-neutral SSE parsing, stream consumption, reconnection primitives, image MIME detection, data-URI handling, source resolution, and shared SVG security policy.

### Patch Changes

- Add Apache-2.0 license files, framework attribution, bundled third-party notices,
  and public npm publishing metadata to every library. Validate these materials
  in package contents before upload and declare required and optional runtime dependencies.
