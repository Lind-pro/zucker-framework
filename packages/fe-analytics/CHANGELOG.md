# @zucker-framework/fe-analytics

## 1.0.16

## 1.0.15

### Patch Changes

- Measure what sent mail achieves and keep product event names consistent.

  - `MailEngagementService.stats()` also reports `bounced`, `complained` and `bounceRate`; the new `byTemplate()` returns the same delivery and engagement figures per template, most-sent first. Both still count each provider message once and compute open/click rates only over delivered messages that were marked as tracked when sent.
  - `MailServiceOptions.linkTracking` tags links to the consumer's own origins with per-message query parameters (for example UTM values from the template or campaign) at the single send point; `tagMailLinks()` is exported for previews. Other links, existing parameters and fragments are preserved.
  - `defineEventCatalog(names)` in `@zucker-framework/fe-analytics` gives a product a closed list of event names: `track` rejects unlisted names at type-check time and `has` lets the receiving server drop unknown ones.

## 1.0.14

## 1.0.13

## 1.0.12

## 1.0.11

## 1.0.10

### Patch Changes

- Add optional site analytics configuration and lifecycle helpers for GA, Clarity,
  Plausible, OpenPanel and Vercel Analytics. Keep scripts disabled without explicit
  configuration and avoid duplicate initialization across client navigation.

## 1.0.8

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
