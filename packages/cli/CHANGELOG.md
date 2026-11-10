# @zucker-framework/cli

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
