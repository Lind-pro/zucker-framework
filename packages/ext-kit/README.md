# @zucker-framework/ext-kit

MV3 capture lifecycle, queue popup driver, licensing cache, confirmed downloads and reversible scroll expansion. Browser-only; no Node/native imports in runtime exports.

## Source status / compatibility

The v2 lifecycle in this tree is **not in published 1.0.2**. A new release is required before consumers replace vendored assets. The new licensing policy port and explicit `freeDailyLimit` are breaking configuration changes. Do not copy sibling source into production or silently replace a mature consumer with 1.0.2 assets.

Runtime modules are native JavaScript with explicit public `.d.ts` contracts. Page functions are serialized to CDP/`executeScript`; bundling must not inject function-name helpers (`keepNames`). `build-vendored.mjs` emits `ext-kit.js`, `ext-kit-popup.js`, and `scroll-capture.js`; `assets/offscreen.{html,js}` belong in the extension root. The engine imports the scroll implementation directly, so it does not depend on a global being loaded first. The standalone scroll asset remains available to direct consumers.

## Public contracts

- `initExtension(ExtKitConfig)` / `ZuckerExt.init(config)`: single startup registration per worker. Keep the original `product` storage namespace, `messagePrefix`, `brand`, badge and download naming policy.
- `CaptureContext.send`: abort-aware CDP commands. **`cleanup` is not blocked by abort**, and must be used by consumer `afterQuick`/restoration hooks.
- `createDownloader(justification, DownloadOptions?)`: waits for Chrome `complete`, rejects `interrupted`, cancels at a bounded deadline, reclaims blobs. `onPrepared(url)` and `onCreated(id)` must durably persist intent before proceeding. `recover(checkpoint, signal?)` verifies extension ownership and reconciles the actual download instead of creating another file. Defaults: 120s deadline, 180s blob lease, 1s polling; `blobLeaseMs` must exceed deadline.
- `createLicensing(namespace, brand, LicensingConfig)`: `activate`, `getStatus`, `getEntitlement`, `deactivate`. No implicit endpoint, response envelope, plan names, credentials, code formatting or timing policy. Configure `requestTimeoutMs`, `cacheTtlMs`, `offlineGraceMs`, `retryDelayMs`, `request(operation,input,signal)` and `normalizeEntitlement(unknown)`. Normalization must validate the consumer's grant; the kit also requires a future `expiresAt`. Status `pro` means a validated paid grant, regardless of its consumer plan name.
- `scrollCapture.prepare(ctx, waitForContent?)` / `restore(ctx)`: expand loaded vertical content without changing widths, reject visible virtual lists rather than claim completeness, retain exact changed CSS properties and original scroll offsets. A page-local lease restores the page after worker loss; normal cleanup is idempotent and uses the non-aborted channel. Call restore in `finally`, including failed prepare. Viewport-only capture must not expand.
- `initPopup(PopupConfig)`: persisted URL queue and settings, inline draft preservation across polling, generation-fenced queue polling, numeric draft validation, bounded same-origin sitemap collection, pagehide cancellation. Uses the existing popup element IDs and `.settings` controls. Consumer owns HTML/CSS, labels, output-specific settings and result presentation.
- Capture budget/naming exports remain public. URL normalization preserves distinct hash routes (no longer strips fragments).

### Consumer policy ports

`LicensingConfig.request` returns `{ accepted, denied?, entitlement?, token?, deactivated? }`. Only set `denied:true` for an **authoritative** rejection/inactive grant from the consumer's protocol. Proxy 403, malformed payloads and transport failures must not erase a recoverable activation. Remote deactivation must succeed (`accepted && deactivated`) before local token removal. Request timeout also bounds a transport that ignores its signal; transport must still use the signal to stop underlying I/O.

`normalizeSettings(defaults,input)` holds PDF/image formats, margins and product UI policy; `migrateSettings(saved)` maps old product settings before normalization. Generic engine readiness/delay flags are bounded separately. `captureScope`, `captureQuick`, `beforeQuick`, `afterQuick`, `beforeScroll`, and `capture` preserve output-specific logic in the consumer. `freeDailyLimit` is explicitly required; no product quota is chosen by Framework.

## Persistence and recovery invariants

- Storage keys remain `<namespace>_batch_state`, `_quick_state`, `_free_usage`, `_owned_tab`, `_license_token`, `_entitlement`, `_device_id`.
- Batch state is version 2. Download URL intent precedes file creation, download ID precedes completion wait. Successful completion and free usage are committed in **one** `chrome.storage.local.set` call. A failed read/write keeps an uncharged download recoverable. Only one capture/reconciliation runs per worker.
- This relies on Chrome's local storage operation semantics and the single engine writer, not on a distributed transaction. Do not write these keys from parallel engines or replace persistence with memory.
- Stop/Clear reconcile existing downloads before dropping checkpoints. Completed output is charged once even if Stop races with completion. Upgrade does not clear a live batch.
- Tab ownership lives in `storage.session`, never durable local storage: stale browser-session tab IDs must not be closed. Cleanup removes only the owned capture tab and untouched idle tab, not a window containing user tabs.
- Offscreen blob leases survive worker suspension; explicit revocation and document pagehide drain owned URLs. Keeping the offscreen document warm avoids a close/create race; URLs, not unrelated documents, are the bounded owned resources.

## Targeted verification

From repository root, using existing dependencies:

```sh
node --test packages/ext-kit/test/engine.test.cjs packages/ext-kit/test/licensing.test.cjs packages/ext-kit/test/lifecycle.test.cjs
node --test packages/ext-kit/test/browser.test.cjs
pnpm exec vitest run packages/ext-kit/src/naming.spec.ts
pnpm exec tsc --noEmit -p packages/ext-kit/tsconfig.json
```

Browser tests use disposable Chromium contexts and synthetic pages/Chrome ports. Set `CHROMIUM_EXECUTABLE` if needed. Engine/license regressions were extracted from two mature consumers and use a synthetic policy adapter; domain output tests remain with consumers. Type checking verifies TS/public declarations, **not all JS implementation internals**. Runtime failure tests and source-bundle browser checks remain required. No real licenses, DB, provider calls or store publication are tested.

Release integration must verify the immutable archive's exports/assets and fixed version, then rerun each consumer's existing capture/download/recovery and popup tests before deleting its old generic implementation. No release or consumer switch is implied by local tests.
