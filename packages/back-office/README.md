# Back office (server)

`@zucker-framework/back-office` packages the server half of the Framework back office, the
counterpart of `@zucker-framework/fe-admin`. Products compose these hosts by version instead of
copying template source. The Framework server template (`templates/server`) is itself a thin
composition of these hosts, and its e2e suites are their regression tests.

| Subpath | Module | Routes (default paths) |
|---|---|---|
| `@zucker-framework/back-office/accounts` | `BackOfficeAccountsModule` | `/authorize/*` sign-up, sign-in, sessions, password, magic link, two-factor, OAuth, API keys, deletion, avatar; `POST /management/users/:id/two-factor/reset` |
| `@zucker-framework/back-office/subscriptions` | `BackOfficeSubscriptionsModule` | `GET /billing/plans`, `/billing/currencies`, `/billing/entitlements/{catalog,me}`; `/management/{plans,subscriptions,quota-usage,quota-reservations}` |
| `@zucker-framework/back-office/billing` | `BackOfficeBillingModule` | `/billing` orders and `POST /billing/webhooks/:provider`, `/billing/subscriptions/*`, `/billing/refunds/*`, `POST /management/orders/:id/recover`, `/management/payment-credentials/*`, `/management/credit-packs` |
| `@zucker-framework/back-office/management` | `BackOfficeManagementModule` | `/management/*` read models: API keys, orders, billing subscriptions, jobs, deliveries, files, access/operation logs, credits, connections |
| `@zucker-framework/back-office/mail` | `BackOfficeMailModule` (global) | `/management/email-templates`, `/management/email-logs`; transports, transactional and account mail |
| `@zucker-framework/back-office/settings` | `BackOfficeSettingsModule` | `/management/connection-settings[/:profileId]`, `/management/policies[/:policyId]`, `/site/public/{config,integrations}` |

The root entry exports only the conventions shared by every host:

- `backOfficeToken(host, name)` returns the injection token `Symbol.for('zucker:back-office:<host>:<name>')`.
  Registered symbols keep tokens identical across the separate CJS/ESM entries of each subpath.
- `resolveModelNames(host, defaults, overrides)` merges a host's default model names with the
  consumer's overrides, rejecting unknown keys and non-identifier names at startup.

## Host rules

- Model and table names are options; no host embeds a literal table name in SQL. Raw SQL quotes
  the resolved identifier.
- Every optional feature can be switched off (`features`); a disabled feature mounts no route and
  reads no table.
- `forRoot(options)` validates and freezes the options; misconfiguration throws
  `TypeError('[back-office/<host>] …')` at startup. Hosts never read `process.env`.
- Global modules (`DATABASE_ADAPTER` of `@zucker-framework/crud`, `ZuckerAuthModule`, logging,
  rate limiter, configuration, notification) are configured once by the consumer's composition root;
  hosts inject them. Hosts that lock or run SQL need a transaction adapter exposing
  `query(sql, values)` (PostgreSQL).
- Ports (mailer, policy, hooks, stores) are typed interfaces; options take a class (registered with
  DI), an instance, or where documented a `{ useExisting: token }` reference.
- Controllers return business values; the consumer's `TransformInterceptor` wraps them. Route
  permissions use `@zucker-framework/auth` metadata; guards default to `JwtAuthGuard` +
  `PermissionsGuard` and can be replaced (`guards: []` when equivalent guards are global).

Adopting the hosts on an existing database (model aliases, expand/contract migrations, legacy tokens,
environment pins, plans-only billing, field maps): see
[existing product adoption](../../docs/existing-product-adoption.md).

## `/accounts`

`BackOfficeAccountsModule.forRoot(options)`; the consumer registers `AccountGuard` (exported) as
`APP_GUARD` together with `PermissionsGuard`.

| Option | Default | Notes |
|---|---|---|
| `models` / `tables` | `DEFAULT_ACCOUNTS_MODELS` / `DEFAULT_ACCOUNTS_TABLES` | Adapter model names; snake_case tables for row/advisory locks and deletion. Optional link tables may be `null`. Keep a `users` alias (auth's `UserService` reads it). |
| `tokens` | access 900 s, refresh 30 d | `extraClaims(user)` (cannot set registered claims), `additionalAccessVerifiers` for legacy tokens: their `{ userId, sessionId }` still passes the session checks. |
| `passwordEncoder` | `BcryptEncoder` | Used everywhere, including the dummy hash (`ScryptEncoder` for scrypt stores). |
| `verification` | `{ mode: 'ticket' }` | `mode: 'code'`: six-digit codes over `emailVerifications` (`attempts` store required; `signInOnVerify`). |
| `mailer` | required | `AccountMailer` class, instance or `{ useExisting: MAIL_ACCOUNT_MAILER }` (the mail host's `BackOfficeAccountMailer`). |
| `policy`, `signupHooks` | `DEFAULT_ACCOUNT_POLICY`, none | Registration/verification/2FA/deletion switches; sign-up transaction hooks. |
| `login.identifier` | `'username'` | Password sign-in identifier (see below). |
| `signup.typeId` | `'member'` | `typeId` of accounts created by `POST /authorize/register` and OAuth sign-up; product sign-up paths read `AccountService.options.signup.typeId`. |
| `cookie`, `origins`, `locales` | `zucker-session` on `/`, none, `['en','zh']` | Refresh cookie; trusted browser origins (mutations from others get 403). |
| `signInMethods`, `profile` | `{}` | Product sign-in methods for `AccountService.signIn(user, method)`; extra `/authorize/me` fields. |
| `features` | `register`, `magicLink`, `twoFactor` on; `deletion`, `avatar`, `apiKeys`, `oauth` off | Each `boolean` or an object (`mount: false` keeps the core behaviour and lets the consumer mount the routes). |

### Sign-in identifier

`login.identifier` decides what `POST /authorize/login` (and the password form of
`POST /authorize/deletion/cancel`) identifies the account by:

| Value | Body | Lookup |
|---|---|---|
| `'username'` (default) | `{username, password}` | Exact username, as before. |
| `'email'` | `{email, password}` | Trimmed, lower-cased address equal to `users.email`. |
| `'username-or-email'` | `{login, password}` | Exact username; a value with `@` is also looked up as an address, and the username match wins. |

- Addresses are matched in the normalized form every host write stores (register, OAuth, code mode).
  Rows written elsewhere with upper-case or padded addresses must be normalized (a backfill) before
  they can sign in by address; an address held by more than one row signs nobody in.
- Unknown, malformed, ambiguous, password-less, disabled and (with verification required) unverified
  accounts all get the same 401 `Invalid credentials or email not verified`, after exactly one hash
  comparison (a dummy hash in the configured encoder's format for misses). With
  `'username-or-email'` and an `@` in the value both lookups always run.
- The `login` / `login-account` budgets key on the normalized identifier (`loginAccountKey(body,
  identifier)`); a two-factor step-up, code-mode verification and additional access-token verifiers
  are unchanged. With `'username-or-email'` the username and the address of one account are separate
  budget keys.
- With an e-mail identifier the deletion confirmation (`confirm`) also accepts the account's address.
- `AccountService.verifyLoginPassword(identifier, password)` and `findLoginAccount(identifier)` give
  product routes the same lookup; `verifyPassword(username, password)` stays username-only.
- Browser forms: `loginIdentifierInput` / `loginRequestBody` of `@zucker-framework/fe-auth`;
  fe-admin's `login.identifier`.

Exports: `AccountService`, `AccountGuard`, `AccountSessionCookie`, `AccountSessionAdminHooks` (for
`ZuckerAdminModule` user hooks), `AccountTwoFactorService`, `OAuthService`, `AccountApiKeysService`,
`AccountDeletionService`, `AccountAvatarService`, `createAccountController`, rate-limit sets
(`ACCOUNT_RATE_LIMITS`, `ACCOUNT_SECURITY_RATE_LIMITS`, `ACCOUNT_API_KEY_RATE_LIMITS`,
`composeRateLimiters`; routes also use the consumer-defined `api-default` limiter) and bootstrap
utilities (`createAdministrator`, `syncMenus`, `syncPermissions` — idempotent, write only what
differs — `assignRole`, `assignRoleByEmail`, `seedStarterData`). Tokens: `ACCOUNTS_*`.

## `/subscriptions`

`BackOfficeSubscriptionsModule.forRoot({ catalog, models, fields, locks, billingLink, planRowExtras, quota, features, paths, settings, billing, viewer, guards, permissions })`.

- `fields` maps logical fields to adapter fields per model (for example
  `quotaUsage: { subjectId: 'userId', counter: 'quotaType' }`); status and cycle values stay
  Framework's (`ACTIVE`, `MONTHLY`, …) in text or enum columns.
- `locks` default to the credit account locks; `advisoryLocks({ account, quota })` for schemas without them.
  `locks.plan` (default `advisoryPlanLock()`, shared for assignments and payment write-back, exclusive for
  plan deletes) keeps a delete from orphaning a term even without a database foreign key.
- `quota` policy: `chargeOnce`, `clearKeyOnFinish`, `legacyResourceTypes`, `insertExtras`, `transitionExtras`, `charged`.
- `features`: `publicRoutes`, `planAdmin`, `subscriptionAdmin`, `quotaAdmin`, `quota`, `paymentWriteBack`.
- `billing` (token of a `SubscriptionsBillingPort`, e.g. `BILLING_SERVICE`) registers plan offers and the
  plan write-back hooks (`createPlanFulfillmentHooks`): checkout and renewal payments record the term;
  a payment refunded in full revokes or shortens the term it defined (`revokePlanTerm`, via
  `SubscriptionAssignmentService.revokePayment`); partial refunds keep it. Term changes are written as
  `billing.plan-term-changed` outbox rows.

`SubscriptionsService` exposes plans, assignments, reservations, entitlements and
`chargeResource(userId, feature, resource, work)` (one charge per resource). Store factories
(`createPlanCatalogStore`, `createUserSubscriptionStore`, `createQuotaReservationStore`,
`createQuotaCapacityStore`, `createResourceChargeLookup`) and `seedPlans` work on any `DatabaseAdapter`.

## `/billing`

`BackOfficeBillingModule.forRoot({ runtime | service, database, models, tables, lockAccount, credits, referrals, ports, returnUrls, trustedOrigins, guards, rateLimit, webhookRateLimit, paths, permissions, features, paymentCredentials, testCheckout })`.

- `credits: null` is **plans-only mode**: no credit tables are read; orders sell plans. It requires
  `lockAccount` (e.g. `advisoryAccountLock()`, or the lock the product's other per-account billing paths use),
  because the default lock lives in the credit ledger's `credit_account_locks` table.
- `features`: `orders`, `subscriptions`, `refunds`, `recovery` (on); `paymentCredentials`, `creditPacks`, `testCheckout` (off; `testCheckout` is for tests only).
- Ports: `checkout` (`verifyOffer`, `verifyRecovery`), `refunds` (`admit` before any row — e.g. an approved
  customer request — and `settled` on the terminal state), `policy`, `credentialArchive`.
- Refunds of plan orders go by paid amount; when one payment is refunded in full the fulfillment hooks'
  `paymentRefunded` runs once in the settlement transaction (`billing.payment-refunded` marker); a plan
  sale no hook revokes is reported as `billing.plan-refund-unapplied`.
- `POST /management/orders/:id/recover { checkoutId }` re-confirms a lost checkout from the verified
  provider session.

Exports `BillingService` (satisfies `SubscriptionsBillingPort`), `BillingRefundsService`,
`BillingSubscriptionsService`, controller factories, persistence helpers, outbox kinds and the fake
payment provider (`createFakePaymentProvider`) for tests. Tokens: `BILLING_*`.

## `/management`

`BackOfficeManagementModule.forRoot({ path, models, tables, features, permissions, trustedOrigins, rateLimit, guards, ports: { refunds, credits, creditLedger, connections } })`.
Features `apiKeys`, `orders`, `billingSubscriptions`, `jobs`, `deliveries`, `files`, `accessLogs`,
`operationLogs` (on), `credits` (off), `creditAccounts` (on with the credits and ledger ports),
`connections` (on with the port). Access/operation logs use the shared log list contract of
`@zucker-framework/admin` (`parseLogRecordsQuery`, `listLogRecords`; query `page`, `pageSize`, `id`,
`ownerId`, `module`, `action`, `startDate`, `endDate`, plus `ip`/`method` or `status`), the same one
`fe-admin`'s log pages read.

## `/mail`

`BackOfficeMailModule.forRoot({ settings, site, templates, localePrefix, links, models, tables, features, admin, delivery, imports })`
(global) and `BackOfficeMailModule.adminControllers(options)`.

- `features`: `admin` (template/log pages), `accountMailer` (default on: `BackOfficeAccountMailer` under
  `MAIL_ACCOUNT_MAILER`, the accounts host's mail port; the verification-code template is added to the
  built-ins unless configured, code mail failures are 503, and the deletion-completed notice removes its own
  delivery-log row), `receipts` (`BillingReceiptMailer`), `seedTemplates`.
- Transports: `SmtpTransport`, Resend, `SMTP_PRESETS` (cloudflare, resend-smtp, sendgrid, mailgun,
  postmark, gmail, office365), `mailSettingsFromConnection(env)`.
- `TransactionalMail` picks the stored or built-in template (`ACCOUNT_MAIL_TEMPLATES`,
  `VERIFICATION_CODE_MAIL_TEMPLATE`), localises subjects, logs every attempt and builds links on the
  configured public origin only.

## `/settings`

`BackOfficeSettingsModule.forRoot({ path, publicPath, environment, database, models, tables, permissions, trustedOrigins, rateLimit, guards, connections, policies })`.

- `connections`: encrypted, revisioned connection profiles (`profiles`, `encryptionKey`), hot apply
  (`HotProvider`, `hotConnectionStatus`), `environmentPins` (a pinned field is reported
  `pinnedByEnvironment`/`readOnly`, refused on save and never written; fully pinned profiles report
  `canSave: false`, `environment_pinned`), `saveGuards` (e.g. `createDataLocationGuard` for storage
  locations), `publicIntegrations`.
- `policies`: product policy definitions (`definePolicy`, `composePolicies`; environment pins
  `POLICY_<ID>_<KEY>`), CAS saves with audit, `GET <publicPath>/config`.
- `ConnectionSettingsService` is the `ConnectionCredentialSource` the billing host reads
  (`SETTINGS_CONNECTIONS`). Tokens: `SETTINGS_*`.

Plan refund history uses the existing unique `(kind, aggregateId)` JSON outbox storage, so no schema
migration is required for hosts already using that schema. `recordPlanTerm` / `revokePlanTerm`
atomically record application snapshots and full-refund markers. Direct `createUserSubscriptionStore`
callers opt in through `options.paymentHistory` (for example `createPaymentHistory(storage)`); the
default does not touch an outbox, preserving legacy payment writers without that model. Those hosts
must add a durable history port before automatic refunds; history-free refunds fail closed. `PLAN_PAYMENT_HISTORY_KINDS` (`subscription.payment-application` and
`subscription.payment-refund`) identifies permanent accounting records: exclude them from delivery
workers and all outbox TTL/cleanup, and retain them with payment evidence after account deletion.
The template's workers select their own event kinds and do not purge these records. Custom consumers
must preserve the same retention contract or supply a dedicated `SubscriptionPaymentHistory` port.
Legacy terms without application snapshots require audited reconciliation; automatic refund
settlement fails closed and can be retried after importing verified snapshots using
`createPaymentHistory().recordApplication`. Do not synthesize admin grants from payment periods.

### Account security update compatibility

`AccountSessionAdminHooks.sensitiveFieldsChanging(change, tx)` now revokes sessions and advances the
credential version in the same transaction as the admin user edit. Use the matching updated admin
package; custom hooks must migrate from post-commit `sensitiveFieldsChanged` to this supplied-transaction
contract. No account-table migration is required.

Email sign-in uses an exact case-insensitive lookup (`equals` with `mode: 'insensitive'`) and requires
exactly one match, including legacy mixed-case rows. Custom model adapters must support this query.
Case-colliding accounts fail closed rather than selecting an arbitrary identity. Review existing
case-insensitive collisions before normalizing stored addresses or adding a case-insensitive unique
index; this update does not mutate existing account data.

The account TOTP host uses its conditional database update as the replay authority. A failed claim or
rolled-back protected action therefore leaves the valid code available for retry; a committed claim
still prevents every later replay across instances. Failed-attempt lockouts remain in force.

Payment revision `0` means the bootstrap environment of the current process. It is not an archived,
immutable configuration across restarts. Keep its account and mode stable for outstanding orders;
when changing test/live mode or provider account across restarts, use a distinct account scope or a
persisted configuration revision. Revision-zero orders fail closed when bootstrap credentials cannot
be assembled or do not identify a mode; they never guess a newer configuration's mode.
