# @zucker-framework/cli

## 1.0.30

### Patch Changes

- @zucker-framework/ai-access@1.0.30

## 1.0.29

### Patch Changes

- @zucker-framework/ai-access@1.0.29

## 1.0.28

### Patch Changes

- @zucker-framework/ai-access@1.0.28

## 1.0.27

### Patch Changes

- Updated dependencies [2abf135]
  - @zucker-framework/ai-access@1.0.27

## 1.0.26

### Patch Changes

- @zucker-framework/ai-access@1.0.26

## 1.0.25

### Patch Changes

- @zucker-framework/ai-access@1.0.25

## 1.0.24

### Patch Changes

- Updated dependencies [d727e57]
  - @zucker-framework/ai-access@1.0.24

## 1.0.23

### Patch Changes

- e7c1b6e: Harden account revocation, transactional credential changes, payment-history replay,
  AI task recovery, cache sequence ordering, dynamic transaction reads, browser session
  isolation, CLI execution and streamed output cleanup after the 1.0.18–1.0.21 review.

  Admin user policies may run in the mutation transaction through `userChanging` and
  `userRolesChanging` (including validated role expiries). Consumers retain policy names
  and must use the supplied transaction and a consistent lock order. Credential hooks
  must migrate from post-commit-only `sensitiveFieldsChanged` to
  `sensitiveFieldsChanging(change, tx)`; required revocation writes commit atomically.

  Direct permission replacement removes legacy untyped links by their stored IDs,
  so consumers with a required grant-type field do not receive an invalid null filter.
  Other grant types remain outside that replacement.

  Custom authentication caches must support atomic sequence advancement/reads. Redis
  sequence values are returned as decimal strings before safe-integer validation to
  avoid RESP integer rounding at the JavaScript boundary.

  AI task consumers must apply the supplied expand-only execution-checkpoint migration
  and coordinate worker cutover. Unknown prior submissions are not automatically sent
  again. Payment history must be retained with the ledger; automatic refunds fail closed
  when the historical application evidence needed to restore entitlements is absent.

  These patch-version contract changes require consumer migration and verification;
  source-level tests do not replace installation of the final immutable release.

- Updated dependencies
  - @zucker-framework/ai-access@1.0.23

## 1.0.22

### Patch Changes

- Updated dependencies
  - @zucker-framework/ai-access@1.0.22

## 1.0.21

### Patch Changes

- 305f24b: Back office server hosts (1.0.21). All changes are additive for existing consumers.

  - back-office (new package; needs an initial maintainer publication and its own npm trusted-publisher
    binding before automatic publication): server half of the back office, composed by version.
    Subpaths `/accounts` (`/authorize/*` accounts, sessions, two-factor, OAuth, API keys, deletion,
    avatar, rate limits, bootstrap utilities), `/subscriptions` (plans, entitlements, user
    subscriptions, quota stores, per-resource charges, plan payment write-back and full-refund
    revocation), `/billing` (orders, provider webhooks, subscriptions, refunds incl. plan orders,
    plans-only mode, order recovery), `/management` (management read models and log lists), `/mail`
    (transports, SMTP presets, template catalog, transactional and account mail) and `/settings`
    (encrypted connection settings, hot apply, environment-pinned fields, policies). Model and table
    names, field maps and every optional feature are options.
  - auth (**security behaviour change**): refresh-token reuse detection. Presenting an already rotated
    refresh token revokes its persistent session (`PersistentSessionRefreshTokenStore.reused`), killing the
    successor refresh token and the session's access tokens; a reuse within 10 s of the last rotation is
    only rejected (lost-response retries), and losing a concurrent rotation is not treated as reuse.
    `RefreshTokenOptions.reuseDetection: false` restores the previous behaviour. Rotation now also stamps
    the session's `lastActiveAt`.
  - auth: `UserService.addUser(data, { passwordless, transaction })` creates accounts without a password
    credential and inside a caller-owned transaction; the created-user event is published after commit.
  - payment: `SubscriptionAssignmentService.revokePayment({ userId, reference })` revokes or shortens the
    term a fully refunded payment defined.
  - admin: one log list contract (`parseLogRecordsQuery`, `listLogRecords`, `projectLogRecord`) shared by
    the log controller factories, the back-office management host and fe-admin; `USER_FILTER` accepts
    an exact `typeId`.
  - fe-admin: `plans.presets`, `users.typeOptions`, `users.passwordReset`, users status/type filters,
    `session.reloadOnFocus`, `login.forgotPasswordHref`, `UserPicker` (searchable account picker, used by
    subscription assignment), environment-pinned connection fields shown read-only, parameterized
    `extraPages` paths.
  - back-office/subscriptions: plan assignments take a shared plan lock and plan deletes an exclusive one
    (`locks.plan`, default PostgreSQL advisory locks), so a delete cannot orphan a term without a database
    foreign key. back-office/billing: plans-only mode (`credits: null`) requires `lockAccount`.
    back-office/mail: the verification-code template is a default built-in while the account mailer is on;
    code mail failures are 503.
  - storage: `WEBDAV_STORAGE_CONNECTION_DESCRIPTOR` and `webDavOptionsFromConnection`.
  - common: `TransformInterceptor` passes raw responses through unchanged (`StreamableFile`, `@Sse()`,
    new `@RawResponse()`, a declared or already set non-JSON `Content-Type` such as Prometheus metrics).
  - cli: `zucker add back-office`; the bundled server template now composes `@zucker-framework/back-office`.

- @zucker-framework/ai-access@1.0.21

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

- 5280170: Launch baseline (phase 1): plans that grant credits, admin-editable credit packs, product policies,
  transactional mail, block-based landing pages and a `zucker create` workspace.

  **BREAKING: `GET /billing/plans` returns an object instead of an array.** The public catalog is now
  `{ plans, packs, checkout }`: `plans` is the former array (each price gains `credits` and
  `creditExpiry` (`'period'`, days or `null`), plans gain `featured`, `badge`, `highlights` and, for a
  signed-in caller, `current`); `packs` lists purchasable credit packs; `checkout` is
  `{ defaultProvider, allowProviderChoice }`. Migration: read `response.plans` where the array was used.
  A request with a valid bearer token is answered `private, no-store`; an invalid token is treated as
  anonymous. `GET /billing/currencies` is new.

  **New projects default to English.** `zucker create <name> [--locale en|zh]` (and
  `pnpm create @zucker-framework/app <name>`) chooses the default routed locale at creation time;
  the default is `en` and both locales always ship. Existing projects keep their configured locale.

  - payment / fe-types / fe-admin: plan prices carry `credits` and `creditExpiry`; plan presentation
    fields and translations (`nameI18n`, `descriptionI18n`, `badgeI18n`, `highlightsI18n`). New
    `CreditPackCatalogService`, `validateCreditPackWrite` and offer ids `plan:<id>:<interval>:<CUR>` /
    `pack:<id>:<CUR>`. fe-admin adds the Credit packs page (`/credit-packs`, `plans:*` permissions) and
    connection apply-mode badges (hot / restart).
  - credit: `consumeOrder: 'expiry_first'` draws the soonest-expiring lots first (never-expiring last);
    the default stays `'fifo'`.
  - fe-site: site documents version 2 (validator accepts v1 and v2, returns v2) with hero variants,
    logo cloud, stats, steps, testimonials, showcase, pricing, newsletter, blog list, changelog and
    media blocks; every href and image is re-checked with `safeSiteHref`.
  - fe-blocks (new): fetch-free React Server Component renderer (`BlockRenderer`) and theme registry
    (`defineTheme`, `resolveThemeBlock`, `--zb-*` tokens) for validated site documents.
  - core: `classifyAddress`, `resolvePublicAddress`, `assertPublicOutboundUrl`, `createPinnedLookup`,
    `pinnedFetch` and `createPublicFetch` (DNS-pinned, public addresses only, no redirects). The rule
    engine HTTP action uses the same implementation; its behaviour is unchanged.
  - cli / create-app (new): `zucker create` generates a pnpm workspace (`apps/server`, `apps/web`,
    `apps/admin`), Dockerfiles, Docker Compose (PostgreSQL, Redis, MinIO, Mailpit, one-shot
    migrations) and one root `.env` with generated secrets. `zucker doctor` checks key lengths,
    origins, database reachability and migration state.
  - notification: `EmailProvider` no longer attempts SMTP AUTH when user and password are both empty
    (local catchers and IP-allowlisted relays).
  - logging: persisted log values replace U+0000 (PostgreSQL rejects it in text/jsonb, which dropped
    the whole log row).

  Server template (copied by `zucker create` / `zucker init`, not versioned): hot-applied product
  policies (`account`, `billing`) with an admin Policies page; registration switch, optional email
  verification, initial role and welcome credits granted once (in the sign-up transaction, or a retry
  task committed with it); sign-up acquisition data; Resend or SMTP for account and transactional
  mail with editable templates and purchase receipts; `changelog` content kind, file-backed starter
  content (published by `pnpm account:admin`), signed Web cache revalidation; remote file imports
  through `createPublicFetch`; payment callbacks that fail verification answer 400. New scripts
  `pnpm account:role` and `pnpm content:seed`. Run `prisma migrate deploy`: the migrations are
  additive (plan credits and credit packs, account acquisition, changelog kind, starter-data markers
  and the new starter menus).

- 1696a82: Platform hardening (phase 4): every connection profile applies without a restart, payment credentials
  are kept per revision, and generated projects ship assistant skills. All changes are additive.

  - config: new subpath `@zucker-framework/config/connections` with the connection-profile machinery
    (`defineConnectionProfile`, `composeConnectionProfiles`, field validation, the
    endpoint-follows-secret rule), `ConnectionProfileStore` (advisory lock, revision compare-and-swap,
    same-transaction audit callback, encrypted revision archive in `connection_profile_revisions`,
    `deleteRevisions` that never deletes the current revision), `ConnectionRuntime` (`environment`,
    `liveEnvironment`, `environmentAt`, `revisions`, `currentRevision`) and `RuntimeProviderSlot`
    (`ttl` or `strict` freshness, leased instances disposed after their last user, a failed build keeps
    the previous instance). The package root export is unchanged.
  - payment: `HostedCheckoutOptions.providers` also accepts a resolver (`ids`, `current`, `forOrder`,
    `webhookCandidates`, at most 8 candidates, own account only); the service captures one adapter per
    operation, and a verified webhook can never settle an order of another account scope. The existing
    array form behaves as before. `staticHostedCheckoutProviders` is exported. Orders may carry a
    `configRevision`.
  - auth, notification, storage, ai, payment: plain-data connection descriptors
    (`connection-descriptor.ts`, one export each) with stable ids, environment keys and label keys; no
    new dependency.
  - cli: project-template bundles carry an optional `skills` field; `create` and `init` install the
    bundled skills (brand quick-start, page builder, feature builder, provider setup, deploy checklist)
    into `.agents/skills` with `.claude/skills` links, never overwriting, never following links out of the
    project, and only warning when a directory is unwritable. New exports `installConsumerAgentSkills`,
    `validateConsumerSkills` and `CONSUMER_SKILL_LIMITS` in `@zucker-framework/cli/agent-instructions`.
  - fe-admin: the Connections page shows per-profile apply errors (`applyError`), the retained revision
    count and the payment hot-apply notice, and asks for confirmation before a private-storage location
    change (409 `DATA_LOCATION_CHANGE_UNACKNOWLEDGED`), resending with `acknowledgeDataLocationChange`.

  Templates (not published packages): payment, sign-in, mail, delivery, storage and AI profiles are
  `applyMode: 'hot'`. New payment orders record `payment-<id>@<revision>` and use the current revision;
  existing orders, subscriptions and refunds use the newest retained revision of their own account (D12).
  Superseded payment revisions are purged only by an operator, older than
  `CONNECTION_REVISION_RETENTION_DAYS` (default and minimum 400; D13). A storage location change while files
  exist needs explicit acknowledgement (D14). New migration `20261112010000_connection_revisions` (it
  archives the current revision of each saved profile at start-up). New server script `content:check`.
  Dockerfiles accept an optional `NPM_REGISTRY` build argument (default unchanged).

  Generated workspace fixes found by the packed-artefact launch acceptance (`pnpm acceptance:launch`):
  - The compose stack could not start: MinIO no longer publishes pullable community images, and production
    refused the internal `http://minio:9000` endpoint. Storage is now SeaweedFS (`chrislusf/seaweedfs:4.01`,
    service still named `minio`, same `MINIO_*`/`FILES_S3_*` keys, app account limited to its bucket), and
    `FILES_S3_INTERNAL_HTTP=true` (environment only) allows plain http to a single-label private host.
  - CMS publish revalidation now reaches Web inside compose (`REVALIDATE_URL=http://web:3000`, and the web
    container receives `REVALIDATE_SECRET`); before, published pages stayed stale for the cache lifetime.
  - `pnpm setup:admin` seeds two example plans and one example credit pack (not purchasable until a
    provider price is added) when `BILLING_CATALOG_JSON` has no offers.

- Updated dependencies
  - @zucker-framework/ai-access@1.0.20

## 1.0.19

### Patch Changes

- @zucker-framework/ai-access@1.0.19

## 1.0.18

### Patch Changes

- @zucker-framework/ai-access@1.0.18

## 1.0.17

### Patch Changes

- @zucker-framework/ai-access@1.0.17

## 1.0.16

### Patch Changes

- @zucker-framework/ai-access@1.0.16

## 1.0.15

### Patch Changes

- @zucker-framework/ai-access@1.0.15

## 1.0.14

### Patch Changes

- @zucker-framework/ai-access@1.0.14

## 1.0.13

### Patch Changes

- Updated dependencies
  - @zucker-framework/ai-access@1.0.13

## 1.0.12

### Patch Changes

- @zucker-framework/ai-access@1.0.12

## 1.0.11

### Patch Changes

- @zucker-framework/ai-access@1.0.11

## 1.0.10

### Patch Changes

- Allow each dynamic form to supply localized interface and fallback validation text without changing
  caller-owned field content, discarding drafts, or changing the default language for existing callers.
  The Admin template supplies its active Chinese/English copy to form previews.
- Generate independent JWT and provider-settings encryption keys in the full Server consumer's private environment file. Preserve their separation and never print either key during initialization.
- Validate user-role replacement input and serialize replacements through the owning user row before
  deleting and inserting memberships. Concurrent replacements must not accidentally combine grants,
  and failed writes retain the previous set. The Admin template exposes the existing assignment API
  through an authorized, localized editor with isolated drafts and retryable failures.
- Ship validated Admin/Web and explicit `server-full` generator assets with the CLI so init works outside a Framework checkout. Preserve the existing `server` fallback behavior, pin generated Framework dependencies and runtime metadata, and include consumer-owned AGENTS.md with an optional relative CLAUDE.md link.

  Add the non-overwriting installConsumerAgentInstructions helper to the existing agent-instructions entrypoint. Exclude private configuration, caches, generated output, uploads and source symlinks from template assets. Make frontend proxy, lint and theme configuration self-contained. The full Server includes its Prisma schema/migrations, account composition and standalone lint tooling, and generates a fresh private JWT environment file. Matching account packages and consumer-owned database/mail configuration remain required; this change does not publish updated artifacts or automatically provision external services.

  Extend the consumer assets with optional verified OAuth, owner-managed API keys, durable hosted
  checkout and credit fulfillment, bounded private attachments/recovery, and configurable public-site
  connections. Web purchase and account pages use those authenticated contracts. Providers remain
  disabled without explicit application configuration; recurring fulfillment and background outbox/file
  recovery workers are not implied by the initial checkout or explicit recovery endpoints.

  Make the default signed-in entry the real account page, preserve legacy dashboard bookmarks through
  localized redirects, and separate authenticated reads from the account mutation rate budget without
  counting the guard twice. Include standalone Admin Node build types, Chinese/English interface
  selection, working default metadata editors and the existing authorized user-role assignment flow.

- @zucker-framework/ai-access@1.0.10

## 1.0.8

### Patch Changes

- Updated dependencies [3aed934]
- Updated dependencies
  - @zucker-framework/ai-access@1.0.8

## 1.0.7

### Patch Changes

- @zucker-framework/ai-access@1.0.7

## 1.0.6

### Patch Changes

- @zucker-framework/ai-access@1.0.6

## 1.0.5

### Patch Changes

- @zucker-framework/ai-access@1.0.5

## 1.0.2

### Patch Changes

- c0de08f: Allow module-wiring consumers to declare expected named APP_GUARD factories separately from class registrations. Imported aliases resolve to the original symbol, and missing, duplicate, unknown or wrong-owner factory registrations remain errors. The audit checks registration identity without pretending to infer a factory's returned guard class.
- c0de08f: Centralize browser-safe field redaction and UA inspection in Core public subpaths; keep existing auth and frontend exports backed by those implementations. Add an optional, explicitly configured Sentry adapter, health-check subsets that fail closed when probes are absent, and reusable mail/webhook provider probes. Reuse webhook transport with injectable fetch, redirect policy and typed delivery errors. Add the runtime-template safe link primitive.

  Applications retain routes, business queries, thresholds, field selections, SDK configuration, locale labels, external-call authorization and message content. Sources and independent tests are prepared; verification and immutable release remain pending.

- c0de08f: Export a directly executable JavaScript agent-instruction audit subpath with configurable document, skill-alias and Git-visibility policy. Both repository scripts use the same implementation; the source file and declaration are explicitly included in the package so running this tool does not require a build or load the TypeScript/CLI command entry.
- c0de08f: Add a side-effect-free library entry for module lifecycle/guard composition, interactive transaction boundaries, Framework import rules and pnpm workflow pin audits. Consumers supply application owner lists and call patterns. Keep the zucker executable at its existing dist/index.js path, separate from library imports, and declare the TypeScript parser dependency.
- Align all public Framework packages to the maintainer-selected 1.0.2 release and keep subsequent releases synchronized through a Changesets fixed group. Package dependencies and the CLI scaffold catalog follow the same version.

  This release consolidates the pending API migrations, including breaking auth and payment persistence contracts. Review docs/package-release-1.0.2.md before upgrading from 1.0.0 or 1.0.1.

- Updated dependencies [c0de08f]
- Updated dependencies [c0de08f]
- Updated dependencies
  - @zucker-framework/ai-access@1.0.2

## 1.0.1

### Patch Changes

- Declare cache/event peers required where the public entry imports their runtime
  tokens unconditionally. This fixes missing modules when consumers install auth,
  crud or rule-engine without the rest of the monorepo. Refresh the CLI scaffold
  catalog so newly generated server projects include the required cache package.
  Refresh credit's packed development dependency metadata for the new CRUD version
  without rebuilding different metadata under an already published credit version.

## 1.0.0

### Major Changes

- First stable public release under the @zucker-framework organization. Publish compiled JavaScript, public type declarations, required runtime assets and Apache-2.0 license materials without source maps.

### Minor Changes

- Add generic AI provider discovery, PostgreSQL Profile initialization, login, status, file import, and smoke commands without provider-specific command branching.

### Patch Changes

- Add Apache-2.0 license files, framework attribution, bundled third-party notices,
  and public npm publishing metadata to every library. Validate these materials
  in package contents before upload and declare required and optional runtime dependencies.
- Replace downstream product names in extension CLI help, API comments, schema
  examples and test fixtures with neutral examples. Consumer-supplied identifiers
  and storage-key behavior are unchanged. The extension template uses reserved
  example domains for licensing and purchase links until the consumer configures
  its own endpoints.
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @zucker-framework/ai-access@1.0.0
