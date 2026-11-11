---
"@zucker-framework/back-office": patch
"@zucker-framework/auth": patch
"@zucker-framework/payment": patch
"@zucker-framework/admin": patch
"@zucker-framework/fe-admin": patch
"@zucker-framework/storage": patch
"@zucker-framework/common": patch
"@zucker-framework/cli": patch
---

Back office server hosts (1.0.21). All changes are additive for existing consumers.

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
