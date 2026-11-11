---
"@zucker-framework/config": patch
"@zucker-framework/payment": patch
"@zucker-framework/auth": patch
"@zucker-framework/notification": patch
"@zucker-framework/storage": patch
"@zucker-framework/ai": patch
"@zucker-framework/cli": patch
"@zucker-framework/fe-admin": patch
---

Platform hardening (phase 4): every connection profile applies without a restart, payment credentials
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
