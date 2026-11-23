# @zucker-framework/ext-kit

## 1.0.30

### Patch Changes

- 4ad4717: Capture no longer hangs or fails on several common page conditions:

  - A stylesheet that never loads blocked painting, so the screenshot waited forever and stalled the batch. Hung subresources are now stopped after the load grace period, and screenshot/PDF commands are bounded by a timeout.
  - Chromium's transient "Unable to capture screenshot" is retried.
  - Clocks, tickers and rotating banners that keep changing without adding content are treated as settled after 3 seconds instead of failing as "still changing".
  - Verification waits probe pages whose load never completes, and auto-scroll stops on pages that cannot scroll.

## 1.0.29

### Patch Changes

- 33fc652: Batch capture no longer fails with "Page load timeout" when a parsed page keeps a request open forever (a hung tracker, font or analytics host). The content is captured after a 10 second grace period with a warning, and later readiness checks for the same page do not wait the grace again.

## 1.0.28

### Patch Changes

- Scroll-area expansion now settles on admin shells (sidebar + top bar), percentage-height footers and panels with absolutely positioned content, and page changes outside the expanded panels no longer block it; the page's original flex styles are restored exactly. Failed page loads report Chrome's network error code with a hint instead of "DNS or network error", and the popup shows result errors and warnings in full (up to 240 characters) instead of cutting them at 60.

## 1.0.27

## 1.0.26

### Patch Changes

- Scroll-area expansion no longer fails with "Scrolling content did not settle in time" on panels whose content is sized from the panel's own height (for example `min-height:100%` plus a footer), on stalled tracking pixels, or on large images that never finish loading. Self-sized panels fall back to their intrinsic height, images of 4000px² or less are ignored, stalled media is captured with a warning after an 8s grace, and `allowUnstable` now also applies to this phase. `ScrollCapture.prepare()` now resolves with an optional warning string that the engine merges into the capture result; custom `scrollCapture` implementations may keep returning nothing.

## 1.0.25

## 1.0.24

## 1.0.23

## 1.0.22

## 1.0.21

## 1.0.20

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

- Replace the old extension engine with the recoverable v2 lifecycle: cancellation-independent cleanup, confirmed/deadlined downloads and leased offscreen URLs, durable download/usage checkpoints, session-owned tabs, reversible scroll expansion with virtual-list rejection/watchdog recovery, and draft-preserving popup polling.

  Breaking configuration: licensing now uses explicit request/normalization ports and cache/grace/timeout/retry policy, freeDailyLimit is explicit, and remote deactivate replaces local clear/isPro. Preserve existing namespaces and use getStatus/getEntitlement. URL normalization now retains hash routes. Add public downloader/scroll/budget APIs and the standalone scroll-capture browser asset.

  This changeset records intent only. No version, lockfile, published package or production consumer was changed; release owners must account for the repository fixed-group policy and validate immutable browser assets before upgrading consumers.

- Expose native BullMQ count keys for compatible monitoring adapters; wait for all producer/worker closes before reporting aggregated shutdown failures, including synchronous throws. Keep document ZIP CRC validation compatible with Node 20 rather than introducing a Node 22-only default-entry import. Add explicit extension lifecycle and browser regression commands. These changes are unreleased; they do not authorize consumer source links or package publication.

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
- Replace downstream product names in extension CLI help, API comments, schema
  examples and test fixtures with neutral examples. Consumer-supplied identifiers
  and storage-key behavior are unchanged. The extension template uses reserved
  example domains for licensing and purchase links until the consumer configures
  its own endpoints.
- Disable source maps in package builds. Release checks now reject source maps,
  inline source map references and uncompiled TypeScript/JSX implementation files
  while retaining public type declarations and required runtime assets.
