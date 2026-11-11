# @zucker-framework/notification

## 1.0.21

### Patch Changes

- @zucker-framework/core@1.0.21
  - @zucker-framework/queue@1.0.21

## 1.0.20

### Patch Changes

- Billing, credit, back-office, notification, licensing and import/export fixes.

  **credit**
  - `CreditService` balance changes lock the account row before reading it, so concurrent consumes can no longer double-spend and concurrent grants are no longer lost; transfers lock both accounts in a stable order and read them only after both locks are held (safe under MySQL REPEATABLE READ too).
  - `grant`, `consume`, `refund` and `exchange` take an optional last argument `{ idempotencyKey }` (stored in `creditOperationReceipts`; the model must exist when keys are used). Reuse with different parameters (account, operation, amount or `orderId`) fails with 409 `CREDIT_IDEMPOTENCY_CONFLICT`, also when the key is used concurrently on another account. With a key, `amount` must be an integer from 1 to 2,147,483,647 (400 otherwise).
  - Credit events are published after commit (also for freeze/unfreeze/expiry); a failing event bus is logged and no longer fails or rolls back the mutation.
  - `checkExpired()` removes only the unspent remainder of an expiring grant (earliest-expiring credits are spent first), never non-expiring credits; each grant is expired once even with concurrent sweeps; unprocessable grants no longer block later ones. New EXPIRE rows carry the expired grant id in `orderId`. Due grants are grouped per account and the ledger is replayed once per account. REFUND, UNFREEZE and TRANSFER_IN credits never expire, so consume-then-refund or freeze-then-unfreeze turns expiring credits into permanent ones (documented, in the user's favour).
  - BREAKING (behaviour): `BatchCreditLedger.expire` pages its scan and continues past failing accounts, then throws a `CreditExpiryError` (an `AggregateError` listing the failures, with the expired total in `expired`) instead of stopping at the first failure. A custom `scanLots().findMany` must honour `orderBy: [{ id: 'asc' }]`, `take` and the `where.id.gt` cursor; a scan that ignores them still terminates. Hold replays accept a store that returns `null` for an absent `resourceId`.

  **admin**
  - BREAKING (security): `PUT /users/:id` and `POST /users` accept only allow-listed fields (`name`, `locale`; plus `password`, `email`, `emailVerified`, `status`, `typeId`; plus `username` on create). Other keys get 400. Changing `password`/`email`/`emailVerified`/`status`/`typeId` additionally requires `users:authorize` (unchanged values resent by fe-admin are fine). Accounts holding `superadmin` can only be updated, re-roled, re-permissioned or deleted by a superadmin. Granting superadmin (a role named `superadmin` or inheriting from one, or a `superadmin`/`*` permission link) through `PUT /users/:id/roles`, `PUT /users/:id/permissions`, `POST /roles` or `PUT /roles/:id` (rename, `parentId`, `permissionIds`) also requires a superadmin. `creatorId` comes from the authenticated actor. Migration: list consumer columns in `ZuckerAdminModule.forRoot({ users: { writableFields, readableFields } })`.
  - BREAKING (response): user routes return an explicit field projection (`id, username, name, typeId, status, email, emailVerified, locale, creatorId, createTime, createdAt, updatedAt`); add other columns via `users.readableFields`.
  - New `users.hooks` (`AdminUserHooks.sensitiveFieldsChanged` / `userDeleted`) so applications can revoke sessions after back-office password, e-mail or status changes.
  - `PUT /users/:id/permissions` and `/dimensions` validate the body, lock the user, and permissions replace only links of the given `grantType`. Deleting a user no longer fails on PostgreSQL when the optional `dimensionUsers` table is missing.
  - `PUT /users/:id` no longer re-inserts a user deleted concurrently, and `''` sent for a field stored as `null` (e.g. `email`) is not a sensitive change.
  - BREAKING (request): the form definition list honours `$like`/`$eq` filters and rejects unknown filter keys with 400. Notification history pages beyond 100 records with a correct total.

  **payment**
  - BREAKING (amounts): KWD/BHD/JOD/OMR/TND use three decimals and Stripe UGX/ISK conversion is correct on every Stripe path (the legacy adapter undercharged these currencies). `currencyExponent`, and with it `toMinorUnits`/`fromMinorUnits`, throws on a currency that is not three letters instead of assuming two decimals. `normalizePlanAmount` requires three decimals for those currencies; plan price snapshots stored with two decimals before 1.0.20 are still accepted by `readPlanPriceSnapshot`. New `toStripeMinorUnits` / `fromStripeMinorUnits`.
  - BREAKING (webhook): legacy Stripe/PayPal webhooks report partial refunds as `partially_refunded`; Stripe `charge.refunded` uses the Checkout Session (or undefined) as `providerRef`, not the charge id. PayPal `PAYMENT.CAPTURE.REFUNDED` derives the state from the order, resolved through the refund's `up` capture link when the event carries no order id, and reports `unknown` when that fails.
  - Retrying a Stripe refund command whose response was lost returns the existing refund instead of a rejection.
  - BREAKING (behaviour): new `OrderService.reconcileOrder` and `resolveRefund`; `created`/`authorized` capture answers return the order to `paying` (previously it stayed `confirming`). A definite 4xx capture or refund rejection is checked with a read-only `retrieve` before the order is released: a capture reopens `paying` only on `created`/`authorized` (PayPal 422 `ORDER_ALREADY_CAPTURED` now records `paid` instead of a cancellable `paying`), a refund returns to `paid` only when nothing was refunded, and an unreadable outcome stays `confirming`/`refunding`; the original error is still thrown. Refund bookkeeping lives in `Order.metadata` (`zucker.pendingRefund`, `zucker.partialRefundCount`; not sent by `retryOrder`); `reconcileOrder` accepts `partially_refunded` as the pending refund's outcome only when no earlier partial refund was recorded, otherwise the order stays `refunding` for `resolveRefund`. New `partialRefundCount`, `pendingRefund`. `retryOrder` accepts description and return/cancel URLs. New `PaymentRejectedError`, `isDefinitePaymentRejection`.
  - New `HostedCheckoutService.resetDispatch` and `onPaymentMismatch` option; definite provider rejections release create/capture claims.
  - BREAKING (behaviour): PayPal calls, including `PayPalPaymentTransport` SDK create/capture/get-order, time out after `timeoutMs` (default 10 s; previously no timeout). Treat a timeout as an unknown outcome and reconcile; non-JSON refund failures surface as HTTP failures.
  - BREAKING (behaviour): `PaymentRecoveryService` sends no mail unless `frontendUrl` or a URL generator is configured and never includes raw provider error messages.

  **notification**
  - BREAKING (behaviour): `CompositeNotifierService` no longer hands one channel's addresses to another channel; supply `fallbackRecipients` per channel to keep cross-channel fallback. `to` is passed through as given. Partial SMS batch failures throw `PartialNotificationDeliveryError` and only failed recipients are retried; a partial-delivery error that lists no failed recipient counts as delivered.
  - The durable worker no longer re-sends a delivered message when saving the delivered state fails: the commit is retried twice with a backoff (200 ms, 1 s) bounded by the remaining lease, then `runOnce` throws and delivery stays at-least-once once the lease expires.
  - `NotifierEventDispatcher` publishes the error topic for `{ success: false }` results.
  - SMS logs mask phone numbers; Tencent keeps E.164 numbers (`defaultCountryCode`, `templateParamOrder`); SMS providers time out (`timeoutMs`, default 10 s).
  - `WebhookRegistry.verify` accepts `sha256=` values; 408/429 are retried; endpoints dispatch in parallel.
  - BREAKING (rendering): a variable at the start of a mail template URL attribute (`href`, `src`, `action`, ...) must be http/https/mailto; `href` also accepts `tel:` and `src` accepts `cid:` and base64 `data:image/png|jpeg|gif|webp`. Other values, including relative paths, render `#` (also in database-stored templates). Text variables are no longer rewritten.
  - Resend bounces suppress only hard bounces of single-recipient messages; the mail campaign start-up reaper is safe with several workers. Campaign progress, completion and failure writes require the campaign to be `running`, so a sender whose BullMQ job was re-delivered while it was still alive stops at its next batch instead of completing a campaign marked failed. New `NotifyHistoryService.count()`.

  **i18n / form / dictionary**
  - `LocaleInterceptor` selects region-qualified locales such as `zh-CN`; `FileMessageSource` rejects malformed locale values.
  - Form definitions are cached for 30 s. BREAKING (validation): invalid patterns and patterns with a nested variable quantifier (`(a+)+`, `(x|y+){2,}`) are rejected on save, and stored forms that already contain one fail validation of every value instead of a 500; a fixed inner count such as `^(?:\d{4})+$` is allowed. Each pattern test runs with a 50 ms limit in a `node:vm` context (catches `(a|a)*$`, `(.*a){20}`); a timed-out test rejects the value. New `compileFormPattern`, `testFormPattern`, `FORM_PATTERN_TIMEOUT_MS`.
  - Dictionary import counts are accurate and import clears the cache and emits change events.

  **ext-server**
  - The Stripe webhook claims the order before minting a licence, so concurrent or retried deliveries create and e-mail at most one licence; orders stay `email_failed` until delivery succeeds. New optional `ExtStore.$transaction` makes fulfilment, activation and resend atomic, and activation locks the licence so parallel devices cannot exceed `maxDevices`.
  - New optional `options.checkout` allow-list (`requireProductMetadata`, `allowedProducts`, `allowedPaymentLinks`, `accept`); without it behaviour is unchanged, and a start-up warning is logged when `stripeWebhookSecret` is set.
  - `adminResendOrder` delivers the new code before revoking the old one and revokes the new code if delivery fails; the final step locks and re-reads the order, so concurrent resends leave exactly one active licence.
  - A unique violation is answered as a duplicate delivery only when it is on the order's `stripeSessionId` (or the error names no key and the order row exists); others, such as a licence `codeHash` collision, are rethrown so Stripe retries.
  - New `options.activationExpiry: 'per-device' | 'license'` (default unchanged).
  - BREAKING (minor): the constructor rejects an empty `licenseSecret`. New licence previews show `PREFIX-…XY`; admin paging is clamped to 1–100; ids over 256 characters get 400.

  **io**
  - CSV import decodes multi-byte UTF-8 split across chunks and stops at `maxRows`. BREAKING (behaviour): `importFromCsv` throws on a record longer than `maxRecordLength` (default 1,048,576 characters), and missing required columns (CSV and Excel) are reported on every row.
  - BREAKING (output): `exportToCsv` prefixes formula-like cells with `'` by default; pass `escapeFormulas: false` for the old output.
  - `detectFormatFromBuffer` recognises CSV starting with a BOM or non-ASCII text.

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
- Updated dependencies
- Updated dependencies [5280170]
  - @zucker-framework/queue@1.0.20
  - @zucker-framework/core@1.0.20

## 1.0.19

### Patch Changes

- @zucker-framework/core@1.0.19
  - @zucker-framework/queue@1.0.19

## 1.0.18

### Patch Changes

- @zucker-framework/core@1.0.18
  - @zucker-framework/queue@1.0.18

## 1.0.17

### Patch Changes

- @zucker-framework/core@1.0.17
  - @zucker-framework/queue@1.0.17

## 1.0.16

### Patch Changes

- @zucker-framework/core@1.0.16
  - @zucker-framework/queue@1.0.16

## 1.0.15

### Patch Changes

- Measure what sent mail achieves and keep product event names consistent.

  - `MailEngagementService.stats()` also reports `bounced`, `complained` and `bounceRate`; the new `byTemplate()` returns the same delivery and engagement figures per template, most-sent first. Both still count each provider message once and compute open/click rates only over delivered messages that were marked as tracked when sent.
  - `MailServiceOptions.linkTracking` tags links to the consumer's own origins with per-message query parameters (for example UTM values from the template or campaign) at the single send point; `tagMailLinks()` is exported for previews. Other links, existing parameters and fragments are preserved.
  - `defineEventCatalog(names)` in `@zucker-framework/fe-analytics` gives a product a closed list of event names: `track` rejects unlisted names at type-check time and `has` lets the receiving server drop unknown ones.

- @zucker-framework/core@1.0.15
  - @zucker-framework/queue@1.0.15

## 1.0.14

### Patch Changes

- @zucker-framework/core@1.0.14
  - @zucker-framework/queue@1.0.14

## 1.0.13

### Patch Changes

- @zucker-framework/core@1.0.13
  - @zucker-framework/queue@1.0.13

## 1.0.12

### Patch Changes

- @zucker-framework/core@1.0.12
  - @zucker-framework/queue@1.0.12

## 1.0.11

### Patch Changes

- @zucker-framework/core@1.0.11
  - @zucker-framework/queue@1.0.11

## 1.0.10

### Patch Changes

- Add optional host interruption to durable task attempts, preserving abandoned leases for recovery while draining in-flight heartbeats. Add a neutral PostgreSQL durable notification repository and schema with atomic enqueue, claims, lease fencing and expired-attempt recovery.
- Updated dependencies
  - @zucker-framework/queue@1.0.10
  - @zucker-framework/core@1.0.10

## 1.0.8

### Patch Changes

- @zucker-framework/core@1.0.8
  - @zucker-framework/queue@1.0.8

## 1.0.7

### Patch Changes

- @zucker-framework/core@1.0.7
  - @zucker-framework/queue@1.0.7

## 1.0.6

### Patch Changes

- @zucker-framework/core@1.0.6
  - @zucker-framework/queue@1.0.6

## 1.0.5

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @zucker-framework/queue@1.0.5
  - @zucker-framework/core@1.0.5

## 1.0.2

### Patch Changes

- c0de08f: Centralize browser-safe field redaction and UA inspection in Core public subpaths; keep existing auth and frontend exports backed by those implementations. Add an optional, explicitly configured Sentry adapter, health-check subsets that fail closed when probes are absent, and reusable mail/webhook provider probes. Reuse webhook transport with injectable fetch, redirect policy and typed delivery errors. Add the runtime-template safe link primitive.

  Applications retain routes, business queries, thresholds, field selections, SDK configuration, locale labels, external-call authorization and message content. Sources and independent tests are prepared; verification and immutable release remain pending.

- c0de08f: Add root-configured mail delivery and a database-backed localized template catalog. Reuse existing template parsing, provider adapters and host database connections. Preserve provider-native idempotency, cancellation, queue rate slots, final delivery history, locale fallback and host-owned template/preview/tracking policies. Extend email providers with complete envelopes and provider receipts; encode binary Resend attachments correctly. Add configurable template-management controllers with separate read/write permissions.

  Move mail history, atomic PostgreSQL engagement statistics, Svix callback verification and single-worker campaign orchestration into shared services. Await interrupted-campaign recovery before registering the worker, preserve atomic claims, and mark queue-add failures explicitly. Batch delivery retains bounded concurrency/deduplication and daily-quota stopping. Host callbacks own audience and suppression policies.

- c0de08f: Add AlertNotificationService using the existing notification deduplication and Webhook transport. Provide DingTalk, WeCom, Slack and generic JSON alert envelopes, acknowledgement validation, delivery outcomes and shutdown draining. Make Webhook URLs absent from success logs because they may contain credentials. Fix zero-timestamp deduplication and expose cache size without another consumer cleanup timer. Destination/severity/fingerprint/redaction policy remains host configuration.
- Align all public Framework packages to the maintainer-selected 1.0.2 release and keep subsequent releases synchronized through a Changesets fixed group. Package dependencies and the CLI scaffold catalog follow the same version.

  This release consolidates the pending API migrations, including breaking auth and payment persistence contracts. Review docs/package-release-1.0.2.md before upgrading from 1.0.0 or 1.0.1.

- c0de08f: Extract consumer-independent cancellation scopes, per-chunk idle timeouts, bounded concurrency admission and timezone helpers; reuse cancellation in the AI adapter. Add signed browser-bound OAuth state, login audit with transactional counters, device parsing and configurable Passport guards. Authorization guards can deny provider errors and select a safe log identity without rewriting request.user.

  Add a validated HTTP query DTO without changing QueryParamEntity. MetadataLogService reuses log persistence for explicitly projected metadata. The optional ai/langchain entry captures call timing and usage without forcing LangChain on other AI consumers.

  Add the single-process task supervisor and temporary export artifact manager. Both preserve their process-local scheduling boundaries: neither introduces durable task storage, distributed leases or multi-executor safety. Consumers retain state transitions, ownership, retry eligibility, prompts, budgets, messages, retention schedules and output policy.

  Source migration only: new APIs, independent test sources and consumers are prepared; verification and immutable publication remain separate pending stages.

  Add durable recipient inbox operations and bounded verified object transfer; retain recipient constraints in updates, reject content collisions, keep dry runs read-only and verify uploaded object bytes before success.

- Updated dependencies [c0de08f]
- Updated dependencies [c0de08f]
- Updated dependencies [c0de08f]
- Updated dependencies [c0de08f]
- Updated dependencies
- Updated dependencies [c0de08f]
  - @zucker-framework/core@1.0.2
  - @zucker-framework/queue@1.0.2

## 1.0.0

### Major Changes

- First stable public release under the @zucker-framework organization. Publish compiled JavaScript, public type declarations, required runtime assets and Apache-2.0 license materials without source maps.

### Patch Changes

- Add Apache-2.0 license files, framework attribution, bundled third-party notices,
  and public npm publishing metadata to every library. Validate these materials
  in package contents before upload and declare required and optional runtime dependencies.
- Harden framework runtime packaging and public error handling, add controller and global-guard registration controls, unify the database adapter token, bound monitoring samples, expose portable metrics and uptime helpers, redact email delivery logs, and protect rate-limit storage keys.
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @zucker-framework/core@1.0.0
