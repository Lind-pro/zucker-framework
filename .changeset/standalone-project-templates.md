---
"@zucker-framework/cli": patch
---

Ship validated Admin/Web and explicit `server-full` generator assets with the CLI so init works outside a Framework checkout. Preserve the existing `server` fallback behavior, pin generated Framework dependencies and runtime metadata, and include consumer-owned AGENTS.md with an optional relative CLAUDE.md link.

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
