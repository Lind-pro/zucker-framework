# @zucker-framework/back-office

## 1.0.29

### Patch Changes

- @zucker-framework/admin@1.0.29
  - @zucker-framework/auth@1.0.29
  - @zucker-framework/config@1.0.29
  - @zucker-framework/core@1.0.29
  - @zucker-framework/credit@1.0.29
  - @zucker-framework/crud@1.0.29
  - @zucker-framework/fe-types@1.0.29
  - @zucker-framework/logging@1.0.29
  - @zucker-framework/notification@1.0.29
  - @zucker-framework/payment@1.0.29
  - @zucker-framework/rate-limiter@1.0.29

## 1.0.28

### Patch Changes

- @zucker-framework/admin@1.0.28
  - @zucker-framework/auth@1.0.28
  - @zucker-framework/config@1.0.28
  - @zucker-framework/core@1.0.28
  - @zucker-framework/credit@1.0.28
  - @zucker-framework/crud@1.0.28
  - @zucker-framework/fe-types@1.0.28
  - @zucker-framework/logging@1.0.28
  - @zucker-framework/notification@1.0.28
  - @zucker-framework/payment@1.0.28
  - @zucker-framework/rate-limiter@1.0.28

## 1.0.27

### Patch Changes

- @zucker-framework/admin@1.0.27
  - @zucker-framework/auth@1.0.27
  - @zucker-framework/config@1.0.27
  - @zucker-framework/core@1.0.27
  - @zucker-framework/credit@1.0.27
  - @zucker-framework/crud@1.0.27
  - @zucker-framework/fe-types@1.0.27
  - @zucker-framework/logging@1.0.27
  - @zucker-framework/notification@1.0.27
  - @zucker-framework/payment@1.0.27
  - @zucker-framework/rate-limiter@1.0.27

## 1.0.26

### Patch Changes

- @zucker-framework/admin@1.0.26
  - @zucker-framework/auth@1.0.26
  - @zucker-framework/config@1.0.26
  - @zucker-framework/core@1.0.26
  - @zucker-framework/credit@1.0.26
  - @zucker-framework/crud@1.0.26
  - @zucker-framework/fe-types@1.0.26
  - @zucker-framework/logging@1.0.26
  - @zucker-framework/notification@1.0.26
  - @zucker-framework/payment@1.0.26
  - @zucker-framework/rate-limiter@1.0.26

## 1.0.25

### Patch Changes

- @zucker-framework/admin@1.0.25
  - @zucker-framework/auth@1.0.25
  - @zucker-framework/config@1.0.25
  - @zucker-framework/core@1.0.25
  - @zucker-framework/credit@1.0.25
  - @zucker-framework/crud@1.0.25
  - @zucker-framework/fe-types@1.0.25
  - @zucker-framework/logging@1.0.25
  - @zucker-framework/notification@1.0.25
  - @zucker-framework/payment@1.0.25
  - @zucker-framework/rate-limiter@1.0.25

## 1.0.24

### Patch Changes

- @zucker-framework/admin@1.0.24
  - @zucker-framework/auth@1.0.24
  - @zucker-framework/config@1.0.24
  - @zucker-framework/core@1.0.24
  - @zucker-framework/credit@1.0.24
  - @zucker-framework/crud@1.0.24
  - @zucker-framework/fe-types@1.0.24
  - @zucker-framework/logging@1.0.24
  - @zucker-framework/notification@1.0.24
  - @zucker-framework/payment@1.0.24
  - @zucker-framework/rate-limiter@1.0.24

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

- Updated dependencies [e7c1b6e]
  - @zucker-framework/admin@1.0.23
  - @zucker-framework/auth@1.0.23
  - @zucker-framework/crud@1.0.23
  - @zucker-framework/payment@1.0.23
  - @zucker-framework/config@1.0.23
  - @zucker-framework/credit@1.0.23
  - @zucker-framework/core@1.0.23
  - @zucker-framework/fe-types@1.0.23
  - @zucker-framework/logging@1.0.23
  - @zucker-framework/notification@1.0.23
  - @zucker-framework/rate-limiter@1.0.23

## 1.0.22

### Patch Changes

- aee88b9: Sign-in identifier options for the back-office account host. Defaults keep the 1.0.21 behaviour.

  - back-office/accounts: `BackOfficeAccountsModule.forRoot({ login: { identifier } })` with
    `'username'` (default, body `{username, password}`), `'email'` (`{email, password}`; trimmed,
    lower-cased address matched against the stored normalized `users.email`, an address on several rows
    signs nobody in) or `'username-or-email'` (`{login, password}`; an exact username wins). Every miss
    (unknown, malformed, ambiguous, password-less, disabled, unverified) answers the same 401 after one
    hash comparison; the `login`/`login-account` budgets key on the normalized identifier. Deletion cancel
    takes the same field and deletion confirmation also accepts the address with an e-mail identifier.
    New `AccountService.verifyLoginPassword` / `findLoginAccount`, `ACCOUNT_LOGIN_IDENTIFIER_FIELDS`,
    `AccountLoginIdentifier`; `loginAccountKey(body, identifier?)`.
  - back-office/accounts: `signup: { typeId }` (default `'member'`) for accounts created by register and
    OAuth sign-up.
  - fe-auth: `loginIdentifierInput(identifier)` and `loginRequestBody(identifier, value, password)`.
  - fe-admin: `login.identifier` selects the sign-in label, input type and request field.

- @zucker-framework/admin@1.0.22
  - @zucker-framework/auth@1.0.22
  - @zucker-framework/config@1.0.22
  - @zucker-framework/core@1.0.22
  - @zucker-framework/credit@1.0.22
  - @zucker-framework/crud@1.0.22
  - @zucker-framework/fe-types@1.0.22
  - @zucker-framework/logging@1.0.22
  - @zucker-framework/notification@1.0.22
  - @zucker-framework/payment@1.0.22
  - @zucker-framework/rate-limiter@1.0.22

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

- Updated dependencies [305f24b]
  - @zucker-framework/auth@1.0.21
  - @zucker-framework/payment@1.0.21
  - @zucker-framework/admin@1.0.21
  - @zucker-framework/config@1.0.21
  - @zucker-framework/core@1.0.21
  - @zucker-framework/credit@1.0.21
  - @zucker-framework/crud@1.0.21
  - @zucker-framework/fe-types@1.0.21
  - @zucker-framework/logging@1.0.21
  - @zucker-framework/notification@1.0.21
  - @zucker-framework/rate-limiter@1.0.21
