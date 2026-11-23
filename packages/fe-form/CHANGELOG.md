# @zucker-framework/fe-form

## 1.0.30

## 1.0.29

## 1.0.28

## 1.0.27

## 1.0.26

## 1.0.25

## 1.0.24

## 1.0.23

## 1.0.22

## 1.0.21

## 1.0.20

### Patch Changes

- Frontend packages, CLI and the bundled admin/web templates (review fixes).

  **fe-form**
  - `DynamicForm` accepts `httpGet` (authenticated fetcher) and `definitionBasePath` for `formId` mode. The definition endpoint requires `JwtAuthGuard` + `form:query`, so pass e.g. a fe-http-client `get`; the default `fetch` now sends same-origin credentials. The `{ status, code, message, result }` envelope is unwrapped and a malformed payload becomes a load error instead of a render crash. `formId` is URL-encoded, stale responses are ignored, and an inline `httpGet` no longer triggers a refetch on every render.
  - Validators read the server parameter names (`min`, `max`, `pattern`) and still accept the legacy `value`. An invalid or missing pattern/limit skips that rule instead of throwing during render or accepting everything.
  - `onFinish` receives values in the server's shapes: JSON → object, ARRAY → array typed by `elementType` (ARRAY fields are now a tag input), DATE → `YYYY-MM-DD`, DATETIME → ISO string, FILE → the result of the new `uploadFile(file, field)` prop (raw `File` objects without it; previously antd `UploadFile` objects). **Behaviour change:** callers that parsed the JSON text or read `UploadFile` objects themselves must drop that step.
  - `field.defaultValue` seeds the form (caller `initialValues` win). `layout.labelPosition` (server spelling) is supported next to `labelAlign`; invalid `columns` fall back to one column. Remote ENUM options handle failures (`optionsLoadFailedText` message) and ignore stale loads.
  - JSON fields accept only a JSON object or array (the server checks `typeof === 'object'`); invalid JSON reaching submit (for example from a custom renderer without the validator) is shown as a field error instead of an unhandled rejection, and `onFinish` is not called. ARRAY options keep their declared number/boolean value when no `elementType` is set.
  - New exports: `normalizeFormValues`, `definitionInitialValues`, `unwrapFormDefinition`, `compilePattern`, `FormValueError`, `parseJsonFieldText` and their types.

  **fe-analytics**
  - **Behaviour change:** `referrer` drops the query string and fragment by default (`referrerPolicy: 'origin-path'`). Use `referrerPolicy: 'full'` for the old value, or `'origin'` / `'none'`. `sanitizeReferrer` is exported.
  - Same-origin beacons are sent as an `application/json` Blob so JSON-only body parsers accept them; cross-origin beacons stay `text/plain` to avoid a CORS preflight.

  **fe-admin**
  - Post-login redirect also rejects control characters (`/\t/evil.com`).
  - A new filter or new `deps` clears the previous rows, so a failed load can no longer show actionable rows of another query.
  - Clickable rows expose a named "Open record" button (visible on focus) instead of a focusable `<tr>`/`role="button"` `<dl>`; pointer row clicks are unchanged.
  - `ResourceTable` takes `pageSizeOptions`; a single option hides the page-size selector.
  - Subscriptions: clearing an end date sends `endDate: null` (the server rejects it with a clear message) instead of silently keeping the stored date. AI models: clearing a stored temperature/max tokens sends `null`, which the catalog accepts; changing the provider or Base URL requires re-entering the API key in the form (the catalog would otherwise reject the save with 400).

  **cli**
  - `zucker add` installs the framework package and its Nest peers at the versions from the CLI's release catalog, exits non-zero when the install fails, and rejects prototype keys such as `constructor`.
  - **Behaviour change:** `zucker ext` only runs from a framework source checkout (it never reads `node_modules/templates`), `sync-server` refuses to overwrite files without the AUTO-GENERATED banner, and `create` validates options (`#rrggbb` colours, single-line bounded text) and escapes substitutions per file type (JSON/JS string escaping, HTML entities); non-text files are copied unchanged.
  - `zucker doctor` prints only the length of `JWT_SECRET`, checks `.env` (or `.env.local`) and requires Node >= 22.12.0 like `engines`.
  - `zucker ai status` and `smoke` no longer run schema DDL; only `store init`, `login` and `profile import` do. A missing table yields a hint to run `zucker ai store init`.
  - `init --template server` only uses `templates/server` from a real framework checkout.

  **templates (bundled by the CLI)**
  - web: baseline security headers on every route (`frame-ancestors 'none'`/`X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`, `base-uri`/`object-src` CSP, HSTS in production). The layout forwards an `x-nonce` request header to SiteAnalytics/SiteConnections for consumers adding a strict CSP. Layout reads run concurrently and site settings time out after 3 s (was 8 s + 3 s sequentially). Download object URLs are revoked after 60 s.
  - admin: the content table is locked to the API's fixed page size of 20; the form-definition list drops the nonexistent "Updated" column (the `name$like` filter relies on the FormController fix in `@zucker-framework/admin`).

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

### Patch Changes

- Allow each dynamic form to supply localized interface and fallback validation text without changing
  caller-owned field content, discarding drafts, or changing the default language for existing callers.
  The Admin template supplies its active Chinese/English copy to form previews.

## 1.0.8

## 1.0.7

## 1.0.6

## 1.0.5

## 1.0.2

### Patch Changes

- Align all public Framework packages to the maintainer-selected 1.0.2 release and keep subsequent releases synchronized through a Changesets fixed group. Package dependencies and the CLI scaffold catalog follow the same version.

  This release consolidates the pending API migrations, including breaking auth and payment persistence contracts. Review docs/package-release-1.0.2.md before upgrading from 1.0.0 or 1.0.1.

## 1.0.0

### Major Changes

- First stable public release under the @zucker-framework organization. Publish compiled JavaScript, public type declarations, required runtime assets and Apache-2.0 license materials without source maps.

### Patch Changes

- Declare Ant Design and its icons as compatible peer dependencies so consuming applications use one supported UI runtime instead of bundling a second major version.
- Add Apache-2.0 license files, framework attribution, bundled third-party notices,
  and public npm publishing metadata to every library. Validate these materials
  in package contents before upload and declare required and optional runtime dependencies.
