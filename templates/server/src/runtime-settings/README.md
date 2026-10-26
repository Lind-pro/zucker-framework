# Saved server connection profiles

`RuntimeSettingsModule` is the application-owned bridge between the existing config store and the
server's provider factories. It exports `ConnectionSettingsService` and `RUNTIME_ENVIRONMENT`.
The token lives in the dependency-free `runtime-settings.tokens.ts`; factories inject it and pass
the resulting environment to their existing options parser. It is resolved once at startup and
frozen. Saving a profile never changes an active SDK, financial task or mail transport.

The eight non-AI server-provider profiles configure the existing Stripe, PayPal, Creem, Google/GitHub login,
account SMTP, durable SMTP/Resend and private S3-compatible storage (including R2) providers.
Six optional native AI profiles configure OpenAI, OpenAI-compatible, OpenRouter, DeepSeek, Anthropic
and Gemini GenAI through the same encrypted store. They default to disabled and construct the existing
native SDK adapters locally; consumer scenario routing remains in application code. See
[`../ai-connections/README.md`](../ai-connections/README.md) for the terminal configuration source,
explicit route mappings and injected `NativeAIClient` contract.
`connection-settings.descriptors.ts` owns the explicit field allowlist. Billing catalog/product
policy, site URLs, local filesystem paths and unrelated server environment variables remain outside
this editor. Two additional public profiles configure the existing five website analytics providers and five
advertising/referral/support connections. Their explicit public IDs, switches and URLs are mapped
without importing another template's source; validation uses the pure public `fe-analytics/site-analytics`
and `fe-site` resolvers.

## Startup and storage

Without a saved profile, the server uses its supplied environment. A saved profile overrides only
its explicitly recorded fields. A stored `null` removes the environment value, allowing the actual
provider parser's default to apply where one exists. Missing fields continue to use the environment.
The dedicated `CONFIG_ENCRYPTION_KEY` must be at least 32 non-blank characters and differ from
`JWT_SECRET`. With no saved profiles, a missing key permits environment-only startup but disables
saving. Any saved profile with a missing, wrong or unusable key fails explicitly; there is no fallback
that would silently activate a different payment or storage account.

Each profile is an encrypted JSON string `{revision, values}` in the existing `config` table under
scope `runtime.connections`. The application constructs `ConfigService` using the current
`ApplicationTransaction`, a local `ConfigScopeManager` that marks each profile encrypted, and core
`SecretCipher` (AES-256-GCM). No new persistence schema or public library is required. No encryption
key, secret plaintext, ciphertext or secret hash is exposed through the administrator responses.

A schema/profile advisory transaction lock and `expectedRevision` compare-and-swap serialize
updates. The encrypted profile write and mandatory `operationLogs` actor audit commit together.
The audit contains the authenticated actor, profile ID, revision and changed field names, never
field values. This private store emits no configuration change events and writes no secret history.
The general `/api/config` API remains fixed to the separate `system` scope.

## Administrator contract

- `GET /api/management/connection-settings`: `{profiles, appliesOn: 'server-restart', externalRequests: false}`.
- `GET /api/management/connection-settings/:profileId`: one profile.
- `PUT /api/management/connection-settings/:profileId`: update and return the saved profile.

Reads require `config:query`; writes require `config:update` and a trusted Origin. All responses use
`Cache-Control: private, no-store`. The only accepted body keys are:

```ts
{
  expectedRevision: number;
  values?: Record<string, string | null>; // allowlisted non-secret fields only
  secrets?: Record<string,
    { action: 'keep' | 'clear' } |
    { action: 'replace'; value: string }
  >;
}
```

An omitted secret or `keep` preserves the existing saved/environment source. `replace` requires a
non-empty string. `clear` explicitly masks the environment value. An empty input never erases a
credential. Unknown fields, client-supplied actor/profile identity and stale revisions are rejected.
A no-op keeps the current revision. Revision conflicts require a fresh read before a deliberate save.

Each profile returns `storedRevision`, `appliedRevision`, `pendingRestart`, `canSave`, field
metadata and field provenance (`saved`, `environment`, `default`, `cleared`, `unset`). Secret fields
return only whether a value is configured and its source; they never contain a `value` property.
The page can therefore show saved versus active settings without revealing credentials. Non-secret
values are the saved candidate, not an assertion that the current SDK has changed.

Saving assembles the relevant existing local options/SDK configuration. It never performs a payment,
refund, email verification/send, object upload or OAuth request. A successful save means local
assembly validation only; remote account access, webhook delivery and actual provider operation
remain separate checks. Credentials and account scopes should be changed with awareness of pending
work; existing payment/refund bindings continue enforcing their original account identity.

## Verification and operations

`test/runtime-settings.persistent.e2e-spec.ts` uses a disposable PostgreSQL schema, real Nest HTTP
permissions, synthetic credentials and actual provider factories. It covers restart loading,
environment fallback and clear/keep semantics, encrypted persistence/no secret events or history,
concurrent CAS, audit-write rollback, missing/wrong encryption keys, generic config isolation and
saved settings reaching Billing/OAuth/delivery/account-mail factories only on restart.

The editor does not rotate the encryption key. Keep the dedicated key available to every intended
server startup; changing it without re-encrypting existing profiles makes them unreadable by design.
No database migration is needed. To roll back application code, preserve encrypted profiles, their
key and audit records. Reverting to a version that ignores saved profiles would reapply environment
configuration and therefore needs an explicit provider-account reconciliation decision.

## Applied public website configuration

`GET /api/site/public/integrations` is an unauthenticated, `no-store` projection of the applied startup
snapshot: `{analytics, connections, revisions: {analytics, connections}}`. It accepts no dynamic
scope or field selector. It never includes server provider profiles, credentials, ciphertext, hashes
or the environment object. A disabled global switch returns only `{enabled: false}`; disabled
providers omit their identifiers and URLs as well. Saving an enabled profile has no public effect
until restart. Invalid enabled startup configuration fails the endpoint instead of emitting scripts.

This endpoint does no database/provider I/O after startup and has no separate shared-IP rate limit:
server-rendered pages otherwise consume one server IP's allowance for all visitors. Administrator
configuration routes retain their permission, Origin and rate-limit checks. The host remains
responsible for ordinary ingress controls.

The website decides consent and eligible routes before mounting any scripts. Public configuration
is not a consent signal or provider availability check. `buildAdsTxt` and both pure configuration
resolvers are reused; no analytics, advertising or customer-support requests are made by the server.
The PG/HTTP suite verifies default-off behavior, authenticated saves, CAS, exact public projections,
disabled-value redaction, secret sentinels and a real HTTP application restart before activation.
