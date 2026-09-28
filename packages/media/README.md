# @zucker-framework/media

Image/SVG helpers and server-side media orchestration. Existing browser-safe exports are in `src/browser.ts`; package browser conditions select that entry and do not load Node processes/filesystem or native SDKs.

## BrowserPool (Node entry, unreleased)

```ts
import { BrowserPool } from '@zucker-framework/media';
import { chromium } from 'playwright'; // owned by the consumer

const pool = new BrowserPool(() => chromium.launch({ headless: true }));
const context = await pool.createContext('unique-job-id', { viewport: { width: 1280, height: 720 } });
try {
  const page = await context.newPage();
  // Product rendering/navigation policy goes here.
} finally {
  await pool.closeContext('unique-job-id');
}
await pool.shutdown();
```

One shared launch per generation, independent contexts, atomic task-ID reservation, retry on the **next acquisition** after launch failure, and recovery on disconnect. No automatic replay of failed jobs. Instantiate once in the application's composition root; the library has no global singleton, environment lookup, executable discovery or sandbox-disabling flags.

`shutdown()` is idempotent, rejects new acquisitions, waits for launches/context creations/in-progress closes, closes contexts then browser, and reports cleanup errors with `AggregateError`. A shutdown waits for resource creation, **not application jobs**: the application must drain jobs before shutdown if those jobs must finish. `closeContext` failures propagate, while bookkeeping is released. Launch and context promises must settle; this pool does not invent an unsafe timeout that abandons resources.

The structural `PoolBrowser`/`PoolContext` ports accept Playwright without a Framework runtime/SDK dependency. `getBrowser()` exposes the neutral browser port; use contexts for job work.

## DocumentTextExtractor (Node entry, unreleased)

`DocumentTextExtractor(ports, options).extract(buffer, format, signal?)`, with format `pdf | docx | doc | image`, returns `{ text, pageCount?, ocrUsed }`.

Ports:

- `pdf(buffer)` returns `{ getText(), destroy() }`, matching PDFParse's page-number/text result. Destroy is called once, including cancellation; the parser must settle `getText` when destroyed.
- `docx(buffer)` returns raw text (e.g. Mammoth). `zipEntries(buffer)` must enumerate **all** members, exposing compressed bytes, uncompressed size, CRC, encryption flag and compression method. Do not pre-inflate members. `validateDocumentZip` validates count, individual/total expanded bytes, CRC and actual decompressed size, with a bounded inflater even for forged headers. Stored and deflated members are supported; encrypted/other methods fail closed.
- `image(buffer, { limitInputPixels, maxDimension })` must enforce pixel limit **inside the decoder before allocation**, apply orientation and return scaled PNG (e.g. Sharp). Framework cannot retroactively bound an already-decoded image.
- `office(buffer, 'doc' | 'docx', signal?)` supplies the consumer's existing conversion/retry service. No Office installation, process or retry policy is hidden in the library.
- Optional `execute` replaces the local command runner for tests/deployment adapters. The default `executeDocumentCommand` uses Node `execFile`, not a shell, propagates cancellation, timeout and bounded stdout/stderr failures, and waits for child close before settling so temporary files are not deleted under a live child.

All policies are explicit `DocumentTextOptions`: OCR page limit, text threshold, input pixels, image dimension, ZIP limits, OCR language, ordered segmentation modes, raster DPI, command timeout/buffer limit, optional temporary root. No filing-specific page count, language or prompt is built in. PDF text pages are preserved; only sparse pages are rasterized using Poppler `pdftoppm` then recognized with Tesseract. Raster dimensions are bounded by the smaller of the configured dimension and the square root of the pixel limit. Sparse OCR can try configured fallback segmentation modes. Temporary directories are removed in `finally` on success, error and cancellation. Abort is checked around non-cancellable SDK calls; an SDK call may still need to finish before cancellation settles.

The default command port requires installed Poppler and Tesseract/language data. The structural ports do not import Playwright, PDFParse, Mammoth, Sharp or AdmZip: these are **consumer adapter dependencies**, not missing mandatory library peers. Tested source integration uses existing Playwright 1.57, pdf-parse 2.x, Mammoth, Sharp and AdmZip. ZIP validation uses portable IEEE CRC-32 rather than a Node 22-only `node:zlib.crc32` import, so the new default entry does not raise the library runtime requirement to the maintainer toolchain version.

`DocumentTextError.code` distinguishes `INVALID_ZIP` (with original cause) and `OCR_PAGE_LIMIT` for localized consumer handling. Other errors remain observable (including native ENOENT/abort errors); applications own localized HTTP error mapping, filename/MIME detection, Office retry policy and filing limits. This API is not yet present in the published `1.0.4` artifact. Publish a new immutable version before migrating production consumers; do not use source links or version overrides to pretend it is released.
