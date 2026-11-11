# @zucker-framework/fe-admin

Reusable back office for Zucker applications: a Radix UI + Tailwind CSS component kit, an app shell
(login, session, backend menu, permission-gated routes) and the standard management pages from
[the back-office RFC](../../docs/back-office-rfc.md). Products depend on it by version, so upgrading
the back office is a version bump. Product policy stays in the product: brand, API prefix, the
entitlement catalog (served by the product's server), registration defaults, extra pages and copy.

Browser-only. Peer dependencies: `react`, `react-dom`, `react-router` (8), `zustand` (5) and
`lucide-react` (one icon set shared with the application). It builds on
`fe-auth` (store, session binding), `fe-http-client` (cookie refresh), `fe-permission` and `fe-storage`.

## Quick start

```tsx
// src/admin.tsx
import { createAdminApp } from '@zucker-framework/fe-admin';
import { ReportsPage } from './pages/reports';

export const { App } = createAdminApp({
  brand: { name: 'Acme Console' },
  apiBase: '/api',
  locales: { 'zh-CN': { label: '中文', messages: {} }, 'en-US': { label: 'English', messages: {} } },
  messages: { 'page.plans': '会员套餐' },                    // copy overrides (any locale)
  serverLabels: { 'en-US': { 'connections.identity-google': 'Google sign-in' } }, // server display text by labelKey
  paymentProviders: ['stripe', 'paypal', 'creem'],           // provider refs shown in the plan price editor
  users: {
    createDefaults: { typeId: 'member' },                    // consumer registration policy
    typeOptions: [{ value: 'member', label: { 'zh-CN': '普通用户', 'en-US': 'Member' } }, { value: 'admin', label: '管理员' }],
    passwordReset: { path: '/users/:id', method: 'PUT' },    // optional; hidden when omitted
  },
  plans: { presets: [{ key: 'pro', label: 'Pro draft', plan: { slug: 'pro', name: 'Pro', prices: [{ interval: 'month', currency: 'USD', amount: '19.90' }] } }] },
  mail: { contentFields: { en: 'htmlContentEn', zh: 'htmlContentZh' } },
  permissions: { plans: { update: 'billing:plans' } },       // only if the server uses other codes
  pages: { aiModels: false },                                // disable or override built-in pages
  // ai: { providers: ['openai', 'anthropic'] },             // required when the aiModels page is enabled
  extraPages: [
    { key: 'reports', path: '/reports', title: { 'zh-CN': '报表', 'en-US': 'Reports' }, permission: 'reports:query', component: ReportsPage },
  ],
});

// src/main.tsx
import './index.css';
createRoot(document.getElementById('root')!).render(<App />);
```

```css
/* src/index.css */
@import "tailwindcss";
@import "@zucker-framework/fe-admin/styles.css";
```

```ts
// vite.config.ts
import tailwindcss from '@tailwindcss/vite';
export default defineConfig({ plugins: [react(), tailwindcss()] });
```

Feature/quota labels are not configured in the browser: the plan editor, subscription snapshot and
quota pages read them from `GET /billing/entitlements/catalog` (RFC §8.1), which the product declares
on its server.

## Tailwind distribution

The package ships `styles.css`, a Tailwind CSS **v4 source** stylesheet (not precompiled CSS). It
declares the theme tokens (`--primary`, `--muted`, … and a `.dark` variant), a few responsive dialog
rules, and `@source "./dist"`, so the consumer's own Tailwind build (`@tailwindcss/vite`) scans the
package's compiled components and emits exactly the utilities they use, in the same cascade layers as
the product's own classes. Product pages written with Tailwind therefore share the tokens and never
duplicate preflight. To rebrand, redefine tokens after the import, e.g. `:root { --primary: #0f766e; }`.
Consumers without Tailwind v4 are not supported.

## Shell behaviour

- **Login** — `POST /authorize/login` (public client), then `GET /authorize/me` with that token; the
  `me` permissions (`{id, actions}`) become `<resource>:<action>` codes.
- **Session** — composed from Framework packages, not a local copy: `createCookieSession` and
  `createSessionSummaryStorage` (`@zucker-framework/fe-auth`) restore the session,
  `createKeepaliveCookieRefresh` + `createRefreshExchange` (`@zucker-framework/fe-http-client`) perform
  the cookie exchange. fe-admin keeps only `permissionsFromMe`, the endpoint defaults and the
  `AdminSession` shape. The access token stays in memory; only `{user, permissions}` is persisted
  (`zucker-admin-session`). After reload the token is restored with the HttpOnly refresh cookie
  (`POST apiBase + '/authorize/refresh'`) under the shared cross-tab lock (`zucker-account-refresh`),
  once per page load (also under React StrictMode). 401/403 sends the user to login; other failures,
  including a refresh that exceeds `session.refreshTimeoutMs` (default 15 s), offer retry. A restore
  whose cookie now belongs to another account signs the page out instead of switching accounts, and
  a sign-in waits for a pending restore.
- **Cross-tab** — when another tab signs out, this tab signs out; when another tab signs in as a
  different account, this tab drops its in-memory session and never overwrites that tab's persisted
  summary with its stale user (only an explicit sign-in in this tab may change the persisted account).
- **Refresh exchange is never cancelled by navigation** — the server rotates the refresh token as
  soon as it accepts the request, so a request cut off by navigation would leave a stale cookie and
  the next restore would be denied as a replay. The exchange therefore uses `fetch` with `keepalive`
  (it completes and stores the rotated cookie after the page unloads) and keeps a marker in
  localStorage (`zucker-account-refresh:in-flight`) while in flight; a page that unloads mid-exchange
  flags it as interrupted, and only the next page (another document) then retries a 401 with backoff
  for up to 10 s. A concurrent refresh in another live tab never causes such waiting. Every HTTP
  answer, including a malformed 200, clears the marker. The server's replay denial is unchanged. A
  custom `config.refresh` gets the same marker/retry/timeout handling (it receives an `AbortSignal`)
  but must itself survive unloads.
- **Session binding** — `jwtSessionKey(['sub', 'sid'])` + `acceptsSessionToken` reject refreshed or
  header-supplied tokens that belong to another session (e.g. another tab signed in as someone else);
  `createSessionRequestScope` aborts in-flight page requests when the user or session changes.
- **Menu** — `GET /menu/tree`; items are shown only if enabled, registered as a page and permitted by
  that page's permission (`fe-permission`; `*`/`superadmin`/`resource:*`). Load failure is shown with retry,
  never replaced by a sample menu. Unchanged starter items (`starter:<key>` with the original zh name)
  are localized; customized names are shown as stored.
- **Routes** — every page is permission-gated: a direct URL without permission renders 403 and makes
  no page request; unknown paths render 404. Menu visibility is UX only; the API stays authoritative.
- **Logout** — `POST /authorize/logout`; an expired session (401) still signs out locally, other
  failures keep the session and show an error.

## Built-in pages

| key | path | permission (default) | API |
| --- | --- | --- | --- |
| dashboard | `/dashboard` | `dashboard:query` | `POST /{users,roles,permissions}/_count`, plans, credits |
| users | `/users` | `users:query` (+ add/update/delete, `users:authorize` for roles) | `/users`, `/users/:id/roles` |
| roles | `/roles` | `roles:query` (+ add/update/delete/authorize) | `/roles`, `/permissions/tree` |
| permissions | `/permissions` | `permissions:query` (+ add/update/delete) | `/permissions` |
| apiKeys | `/records/api-keys` | `api-keys:query` | `/management/api-keys` |
| plans | `/plans` | `plans:query` / add / update / delete | `/management/plans`, `PATCH …/:id/status` |
| userSubscriptions | `/user-subscriptions` | `subscriptions:query` / update | `/management/subscriptions[/:userId]` |
| quotaUsage | `/quota/usage` | `quota:query` | `/management/quota-usage` |
| quotaReservations | `/quota/reservations` | `quota:query` / `quota:update` | `/management/quota-reservations`, `…/:id/release|confirm` |
| orders | `/records/orders` | `billing:query` | `/management/orders` |
| billingSubscriptions | `/records/subscriptions` | `billing:query` | `/management/billing-subscriptions` |
| refunds | `/refunds` | `billing:refund` | `/billing/refunds*` |
| credits | `/credit` | `credit:query` / `credit:grant` | `/management/credits*` |
| emailTemplates | `/mail/templates` | `mail:query` / `mail:update` | `/management/email-templates` |
| emailLogs | `/mail/logs` | `mail:query` | `/management/email-logs` |
| jobs / deliveries / files | `/records/{jobs,deliveries,files}` | `jobs:query` / `notification:query` / `files:query` | `/management/*` |
| accessLogs / operationLogs | `/access-log`, `/records/operation-logs` | `logging:query` | `/management/{access,operation}-logs` |
| health | `/system-monitor` | `dashboard:query` | `/health` |
| aiModels | `/ai-models` | `ai-models:query` / read-secret / add / update / delete | `/management/ai-models` |
| connections | `/connections` | `config:query` / `config:update` | `/management/connections`, `/management/connection-settings` |
| menu | `/menu` | `menu:query` (+ add/update/delete) | `/menu/all`, `/menu` |
| dictionary | `/dictionary` | `dictionary:query` (+ add/update/delete) | `/dictionary`, `/dictionary-item` |
| profile | `/profile` | signed in | `/authorize/me|profile|password|sessions` |

Pages are separate chunks (`React.lazy`, rendered inside the route's `Suspense`), so disabled or
unvisited pages are not part of the initial bundle; the ESM build is code-split, the CJS build stays
a single file. Page components remain importable from the package root for custom layouts.

Page notes:

- **plans** — a plan has a list of `prices` (RFC §8.2): interval `month` / `year` (renewed through a
  provider subscription), `one_time` (one payment for `termDays` of access) or `lifetime`; one price
  per interval + currency; amounts are exact decimal strings; `providerRefs` per configured payment
  provider (`paymentProviders`, Stripe references must be `price_…`). Saving sends the plan's
  `revision` as `expectedRevision`; a concurrent edit is rejected with 409 and the draft is kept.
  Wire types come from `@zucker-framework/fe-types/back-office`.
- **plans presets** — `plans.presets` adds one button per preset next to "Create plan" (with
  `plans:add`). A preset only fills the create editor (`presetToDraft`: the preset's values over an
  empty, unlisted plan, amounts as decimal strings) and names the preset above the form; nothing is
  written until the operator saves, and Cancel discards it. Keys outside the entitlement catalog are
  flagged by the editor like any other draft. Preset keys must be unique (checked by `resolveConfig`).
- **users** — `users.typeOptions` adds a type column, a required type select on create (initially
  `createDefaults.typeId` when it is an option) and on edit; an existing account's type can be changed
  only with `users:authorize` (as the server requires) and is sent only when changed. A stored type
  outside the options stays selectable. The list filters by username/email (substring), status and,
  with `typeOptions`, type (exact; `USER_FILTER` of `@zucker-framework/admin`, `typeId` from 1.0.21).
- **users password reset** — shown only when `users.passwordReset` is configured, and only with
  `users:authorize`. The dialog asks for the new password twice (optional `minLength`) and sends
  `{ "password": "<new>" }` with `method` (default `POST`) to `path` (`:id` = user id); any non-2xx
  keeps the input and shows an error. Server contract: the route must require `users:authorize`,
  apply the account password policy, store only a hash and end the account's existing sessions.
  With `@zucker-framework/admin` use `{ path: '/users/:id', method: 'PUT' }`: `PUT /users/:id`
  accepts `password` only with `users:authorize`, hashes it through `UserService`, and calls
  `AdminUserHooks.sensitiveFieldsChanged({ fields: ['password'] })`, where the application revokes
  sessions (the server template's `AdminUserSessionHooks` bumps `credentialVersion` and revokes the
  refresh sessions). A product endpoint such as `POST /users/:id/reset-password` works the same way.
- **userSubscriptions** — a new assignment offers `UserPicker` (with `users:query`): type two or more
  characters of a username (or an email address) and pick a result to fill the account ID; pasting the
  ID still works. The modify dialog sends `startDate`/`endDate` only when changed (an
  untouched paid term keeps its exact times), never sends an end for `LIFETIME`, and requires one for a
  new `ONE_TIME` term. Lifetime terms are revoked (status `EXPIRED`) instead of cancelled. The list
  filters on stored `status` and on derived validity (`active=active|inactive`). A 409
  `pending_payment` names the blocking order or provider subscription.
- **connections** — fields the server reports as `readOnly` or `pinnedByEnvironment` (or lists in
  the profile's `pinnedFields`) are shown with their value and source but offer no action and are never
  sent; a fully pinned profile (`saveUnavailableReason: 'environment_pinned'`) explains that its values
  come from the deployment environment.
- **quotaReservations** — `changed: false` from release/confirm is reported as "already settled".
- **aiModels** — provider ids are product vocabulary: set `ai.providers`; without it the page shows a
  warning and offers no create.

`login.identifier` (`'username'` by default, `'email'` or `'username-or-email'`) must match the
server's `BackOfficeAccountsModule` `login.identifier`: it selects the sign-in label and subtitle
(`shell.username` / `shell.email` / `shell.usernameOrEmail`), the input type (`email` for e-mail
only) and the request field (`username`, `email` or `login`), through `loginIdentifierInput` /
`loginRequestBody` of `@zucker-framework/fe-auth`.

`login.forgotPasswordHref` shows a "Forgot password?" link under the sign-in form (a site-relative
path or an http(s) URL, checked by `resolveConfig`). Set it only when the server offers password reset
(for example the site's forgot-password page backed by `POST /authorize/forgot-password`).

`session.reloadOnFocus: true` re-reads `/authorize/me` when the window regains focus or comes back
online (at most every 30 s), so permission changes apply without a reload.

## Product pages (`extraPages`)

`extraPages` are routes of the shell's **data router** (`createBrowserRouter`; tests pass a memory
router through `createAdminApp(config, { createRouter })`). A product page component can use the kit
(`PageContainer`, `ResourceTable` + `crudLoader`/`pageLoader`, `FormDialog`, `useAdminApi`,
`useResource`, `usePermissionCheck`, `useAdminI18n` …) together with the react-router 8 hooks,
including those that need a data router: `useParams`, `useSearchParams`, `useNavigate`, `Link`,
`useBlocker` (unsaved-change prompts), `useNavigation`, `useRevalidator`. Paths may contain
parameters (`/reports/:id`); the menu, breadcrumb and permission gate match them, and the most
specific page wins. Route `loader`/`action` functions are intentionally not part of
`AdminPageDefinition`: they would run before the session is restored and before the permission
gate, so data is loaded inside the page with the session-bound `useAdminApi()` (aborted on sign-out
or account switch). See `src/app/extra-pages.spec.tsx`.

Endpoints are overridable through `endpoints`. Idempotent commands (credit grants, refunds) use
`operationAttempt()` keys that survive refresh and store only a hash of the request body, and re-read
`/authorize/me` before reusing a key.

## Component kit

`PageContainer`, `Panel`, `DataTable` (desktop table / mobile cards, selection, pagination),
`ResourceTable` + `useServerTable` (server pagination, filters, loading/empty/error-with-retry,
abort of superseded requests), `FilterBar`, `FormDialog` + `FormFields` (built-in validation, draft
kept on failure, focus on first invalid field), `Dialog`, `Drawer`, `ConfirmDialog`/`ConfirmButton`,
`StatusBadge`, `Notice`, `EmptyState`/`ErrorState`/`LoadingState`, `toast`, `KeyValueList`,
`JsonView`, `Tabs`, inputs (`Input`, `Textarea`, `Select`, `Checkbox`, `Switch`, `Field`), `UserPicker`
(account search over `POST {endpoints.users}/_query`). Hooks:
`useAdmin`, `useAdminApi`, `usePermissionCheck`, `useResource`, `useEntitlementCatalog`,
`useAdminI18n`. Dialogs become full-screen sheets below 768px; controls meet 44px touch targets.

## i18n

Copy lives in a typed messages object: `zhCN` (default, always loaded) and `enUS` are built in;
other built-in copy is a separate chunk loaded when that locale is first used (`loadAdminMessages`).
`messages` overrides apply to every locale, `locales[tag].messages` to one. Business data (menu names, plan
names, records) is never translated.

Display text that the *server* defines in code — connection names, categories, field labels,
descriptions and status notes (`/management/connections`, `/management/connection-settings`) and the
entitlement catalog's labels, descriptions and units — is translated with `serverLabels`:

```ts
createAdminApp({
  serverLabels: { 'en-US': { 'connections.identity-google': 'Google sign-in', 'connections.category.sign-in': 'Sign-in' } },
  // or: serverLabels: (keyOrText, locale) => myCatalog[locale]?.[keyOrText],
});
```

The server sends a stable `labelKey` next to each text (`connections.<profileId>`,
`connections.category.<id>`, `connections.field.<KEY>` and `<field key>.description`,
`entitlements.feature.<key>` (+ `.description`), `entitlements.counter.<key>` (+ `.unit`)). Lookups
try the key first, then the exact text, so rewording the server text does not lose a translation;
text without a translation is shown as received. Pages and product code can use
`useAdminI18n().serverLabel(text, labelKey)` for the same lookup.

## Tests

`src/shell.spec.tsx` (login, restore, session binding, menu filtering, 403/404, logout),
`src/app/session-restore.spec.tsx` (restore under StrictMode and navigation, hanging refresh,
cross-tab sign-out/switch, request abort on sign-out; the exchange itself is tested in fe-http-client
`cookie-refresh-exchange.spec.ts`), `src/pages/credits.spec.tsx`, `src/pages/connections.spec.tsx` (server labels),
`src/components/data-table.spec.tsx`, `src/pages/plans.spec.tsx`, `src/pages/plans.presets.spec.tsx`,
`src/pages/users.options.spec.tsx` (type options, password reset, status filter),
`src/app/extra-pages.spec.tsx` (product pages in the data router), `src/pages/subscriptions.spec.tsx`,
`src/lib/operation-attempt.spec.ts`; run with the root `vitest` (`npx vitest run packages/fe-admin`).
