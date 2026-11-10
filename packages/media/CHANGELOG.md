# @zucker-framework/media

## 1.0.19

## 1.0.18

## 1.0.17

## 1.0.16

### Patch Changes

- Keep Word equations when reading DOCX text. `ommlToLatex(xml)` converts an Office Math (`m:oMath`/`m:oMathPara`) element to LaTeX — fractions, scripts, radicals, delimiters, n-ary operators, accents, functions, limits, bars, equation arrays and matrices, with Greek letters and operators as LaTeX commands. `readDocxDocumentText(documentXml)` reads `word/document.xml` as text with inline equations in `$…$`, display equations in `$$…$$` and table cells separated by tabs. Plain-text DOCX readers such as mammoth's `extractRawText` drop equations entirely.

## 1.0.15

## 1.0.14

## 1.0.13

## 1.0.12

## 1.0.11

## 1.0.10

## 1.0.8

## 1.0.7

### Patch Changes

- Restore double-escaped numeric references in Mermaid SVG text, including references split across adjacent tspans. Keep restored markup inert as text, leave attributes and styles untouched, and preserve SVG sanitization and XML code-point validation. Apply the same normalization to browser rendering and Mermaid responses from Kroki.

  Remove trailing monochrome style semicolons that Mermaid incorrectly interprets as part of a color entity. Public rendering APIs remain unchanged.

## 1.0.6

## 1.0.5

### Patch Changes

- Add server-side BrowserPool lifecycle orchestration with shared launch, isolated contexts, launch retry, disconnect recovery and draining shutdown. Add SDK-neutral DocumentTextExtractor ports with mixed PDF/OCR extraction, cancellation-aware execFile cleanup and explicit page/pixel/ZIP limits. Keep browser exports free of Node/native dependencies and consumer policy explicit.
- Expose native BullMQ count keys for compatible monitoring adapters; wait for all producer/worker closes before reporting aggregated shutdown failures, including synchronous throws. Keep document ZIP CRC validation compatible with Node 20 rather than introducing a Node 22-only default-entry import. Add explicit extension lifecycle and browser regression commands. These changes are unreleased; they do not authorize consumer source links or package publication.

## 1.0.4

- Add opt-in monochrome Mermaid and RDKit rendering while preserving diagram content.
- Preserve visible SVG text bounds and improve sequence label wrapping for document export.
- Accept only the standard SVG 1.1 DTD preamble without resolving external declarations; continue rejecting arbitrary DTDs and entities.

## 1.0.3

### Patch Changes

- Provide a browser export condition containing image, SVG and Mermaid helpers without Node RDKit/Vega renderers. Preserve the Node rendering API.

## 1.0.2

### Patch Changes

- c0de08f: Add reusable client CRUD, typed auth stores with consumer logout/permission hooks, best-effort browser storage, portable Mermaid sanitization/layout/rendering, and shared template placeholders.
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
