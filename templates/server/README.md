# NestJS Server Template

通用 SaaS Server 消费者示例。账户机制复用 Framework 的 UserService、持久会话、刷新轮换、单次票据、权限和邮件 Provider；本模板持有用户 schema、公开注册政策、消息正文和环境配置。

后台服务端由 `@zucker-framework/back-office` 的宿主组合而成（`/accounts`、`/subscriptions`、`/billing`、`/management`、`/mail`、`/settings`）：`src/accounts/account.config.ts`、`src/subscriptions/storage.ts`、`src/billing/billing.config.ts`、`src/management/management.config.ts`、`src/mail/mail.module.ts`、`src/runtime-settings/`、`src/policy/` 只保留本模板的配置、产品策略与数据（套餐目录、权益目录、邮件文案、连接配置项、菜单与权限）。宿主的选项与契约见该包 README；既有产品接入见 Framework 文档 `docs/existing-product-adoption.md`。

## 初始化与运行

当前本地 CLI 新增 `--template server-full`，始终从随包资产生成本完整模板；仓外旧的 `--template server` 仍保留最小内存骨架。两种模式明确区分，推荐新持久应用使用 server-full。本轮账户接入及相关公共包修改尚未发布，源码 manifest 版本不能代替实际制品验证。

1. 使用与本模板匹配的固定 Framework 包，将 `workspace:*` 转为已核验版本；正常项目不依赖相邻源码目录。
2. 安装本项目依赖。CLI `server-full` 已生成权限0600、带分别随机生成的 JWT_SECRET 和 CONFIG_ENCRYPTION_KEY 的私密 `.env`，直接填写该文件，不要覆盖它；手动复制模板时才复制 `.env.example` 并分别设置至少32字符、互不相同的 JWT_SECRET 与 CONFIG_ENCRYPTION_KEY。保存过加密连接设置后应保留原配置加密密钥，重启或包升级不能重新生成它。然后配置独立 PostgreSQL 地址、ACCOUNT_ORIGINS 和 WEB_URL。完整模板缺数据库会明确停止，不能用内存冒充账户持久化。
3. 执行 `pnpm prisma:generate`、`pnpm db:migrate`，只对本项目数据库执行迁移。初始迁移创建表；后续凭据版本触发器确保后台改密也使旧会话和重置链接失效。不要用 schema push 代替迁移而遗漏触发器。
4. 执行 `pnpm dev`。Server 默认 `4200`，API 前缀 `/api`。SMTP 不是启动依赖；可以先用显式初始化的已验证管理员检查管理端登录。启用普通注册、邮箱验证或找回密码前再配置账户 `SMTP_*`，缺少配置时这些操作明确返回不可用。
5. Web 默认 `4202`、Admin 默认 `4201`；ACCOUNT_ORIGINS 要包含实际浏览器 origin。开发代理保持同源请求，生产须明确 HTTPS 与转发配置。

应用启动不创建默认账户、角色或固定密码。需要首位管理员时，在私密环境中设置 BOOTSTRAP_ADMIN_USERNAME/EMAIL/PASSWORD，显式执行 `pnpm account:admin`；使用满足正常用户名/密码策略的账户名。命令拒绝覆盖或提升已有账户，并补齐带读取权限的初始菜单而不覆盖用户已有菜单；成功后删除引导密码配置。该命令只供应用所有者受控初始化，不是公开注册入口。同一事务还写入一次性起始数据：`BILLING_CATALOG_JSON` 的订阅商品成为套餐、一次性商品成为积分包（只写一次，记录在 `starter_data_markers`，管理员删除后不会重建），`content/` 下的起始页面、博客、文档和更新日志发布进 CMS（已存在的条目不变）。之后 `pnpm content:seed [--publish]` 可再次复制 `content/` 中新增的文档；`pnpm account:role -- --email <地址> --role <角色名或 ID>` 给已有账户授予已有角色。

账户邮件和持久任务通知分别配置：账户、欢迎、回执与 MailService 邮件按 `MAIL_PROVIDER`（`smtp` 默认，或 `resend` + `MAIL_RESEND_API_KEY`）发送，发件人为 `SMTP_FROM`，`SMTP_USER/SMTP_PASSWORD` 都为空时不做 SMTP 认证；任务通知使用 `DELIVERY_PROVIDER=none|smtp|resend` 与 `DELIVERY_*`，默认不投递。配置一种不会自动启用另一种，字段见本项目 `.env.example`。

## 账户协议

| 入口（均以 `/api/authorize` 开头） | 行为 |
| --- | --- |
| `POST /register` | username/email/password/locale/utm；注册普通成员。产品策略 `account` 决定是否开放注册、是否需要邮箱验证（默认需要，返回 `{verificationRequired:true}`；关闭时直接登录，返回 `{verificationRequired:false,userId,token,expires}` 与刷新 Cookie）、初始角色与欢迎积分（与用户同一事务发放，失败时在同一事务提交重试任务，只发放一次） |
| `POST /verification`、`POST /forgot-password` | 发送验证/找回链接；未知邮箱返回同样的 accepted 响应 |
| `POST /verify-email`、`POST /reset-password` | 消费一次性票据；票据与账户变更在同一数据库事务中提交 |
| `POST /login` | 返回短期 token，将刷新令牌放入 HttpOnly `zucker-session` Cookie |
| `POST /refresh` | 只从 Cookie 刷新，返回 access_token；并发轮换只允许一次成功 |
| `POST /logout` | 撤销当前会话；重启后仍拒绝旧访问/刷新令牌 |
| `GET /me`、`POST /profile` | 只读或更新当前账户允许的资料字段 |
| `GET/POST/DELETE /avatar`、`GET /avatar/content` | 私有头像、稳定请求编号与版本检查；2MiB PNG/JPEG归一化，移除只解绑 |
| `POST /password` | 验证当前密码后改密，撤销全部旧设备；旧邮件票据失效 |
| `GET /sessions`、`DELETE /sessions/:id` | 只查看/撤销本人的会话，不暴露刷新标识 |

修改类账户请求须带允许的 Origin；跨站 Cookie 请求拒绝。刷新和访问令牌有不同 audience/type，刷新令牌不能作为 API Bearer 凭证。会话采用数据库固定有效期，刷新不会延长数据库期限；退出、账户停用、密码变更均由数据库事实判定。

限流策略集中在 `src/rate-limits.ts`（`APP_RATE_LIMITERS`）。登录、注册、邮箱验证、找回/重置密码和其他账户写操作使用严格的 `accounts` 预算（每 IP 每分钟 20 次）。每次整页加载都会调用 `POST /authorize/refresh` 与 `GET /authorize/me`，因此它们不占用凭据预算：刷新按已验签刷新令牌的会话计数（`session-refresh`，每会话每分钟 60 次），另有每 IP 每分钟 300 次的总上限（`session-refresh-network`，含无效 Cookie）；`me` 按用户计数（`session-read`，每分钟 120 次）。刷新令牌的轮换与重放拒绝不变。本人会话列表、API Key、头像和外部绑定读取使用 `api-default` 的用户维度预算，公开提供方列表按来源 IP 读取预算计数。`test/account-rate-limits.persistent.e2e-spec.ts` 以实际策略验证两点：正常浏览不被限流，凭据端点保持严格。登录另有两个按目标计数的失败预算：同一账户加同一客户端 IP 每 15 分钟 5 次（`login`），同一账户跨所有来源每 15 分钟 30 次（`login-account`），成功登录退还额度。已接受的风险：任何人对某账户在 15 分钟内累计 30 次失败尝试后，该账户在窗口结束前即使输入正确密码也会被拒绝（可被用来短时锁定用户）；模板没有会话绑定 Cookie 可用于豁免已知设备。需要更强保证的部署应调高 `login-account` 预算、接入共享 Redis 预算并监控该限流，或在应用中实现已知设备豁免。组合根关闭重复的全局限流 Guard，各控制器在认证之后显式使用 `RateLimitGuard`，一次请求只消耗一次。新增受限控制器沿用 `@UseGuards(RateLimitGuard)` 与 `@RateLimit(...)`，不另注册第二个全局实例。

邮件票据只保存 SHA-256 摘要。链接将原始票据放在片段 `#ticket=...`，页面读取后移除地址中的片段，再以请求正文提交，避免进入访问日志或 Referer。邮件投递仍是明确的即时发送，失败可请求新链接；本批不宣称已具备崩溃恢复 outbox。

## 验证与边界

`test/accounts.persistent.e2e-spec.ts` 使用显式 TEST_DATABASE_URL，仅允许命名为 `_dev`/`_test`/`_tests` 的数据库，创建随机私有测试 schema、应用本模板全部迁移并清理。用合成邮件替身检查真实 PostgreSQL 事务、并发刷新、重启、所有权、改密与票据回滚，不发送真实邮件或使用真实账户。

全应用测试验证实际 AppModule 装配；包内会话测试只验证原语，不能代替数据库证据。默认管理功能、支付、任务、存储、通知等能力按各自接入记录判断，账户成功不代表全部 SaaS 能力已对齐。

## Optional Google, GitHub and One Tap identity

OAuth is off by default. Configure the explicit switches and credentials in `.env.example`; `GET /api/authorize/oauth/providers` reports only usable modes and exposes no client secret. Register each authorization-code callback as `WEB_URL/api/authorize/oauth/google/callback` or `WEB_URL/api/authorize/oauth/github/callback`. Google One Tap also requires the Web origin in the Google application's authorized JavaScript origins. The Web app discovers these settings from the API and loads Google's identity SDK only after an explicit One Tap action.

The `oauth` module owns application policy and persistence. Code flows use server-generated state, nonce and S256 PKCE. Intents and handoff proofs are short-lived, atomically claimed database tickets bound to a host-only HttpOnly browser cookie; linking also binds the authenticated user and session. The provider callback checks the saved origin when Origin is present, while permitting the normal top-level cross-site GET redirect without an Origin header. Start, One Tap, completion and unlink mutations require the configured Web origin. Provider errors are replaced with fixed messages and callback proofs use a fragment that the Web page clears before confirmation.

`POST /api/authorize/oauth/:provider/start` starts login; authenticated `/:provider/link/start` starts explicit linking. Code callbacks and `/google/onetap` verify identity and issue a handoff. The Web confirms it through `/:provider/complete` or authenticated `/:provider/link/complete`. Account connections are listed at `/connections` and disconnected with `DELETE /connections/:provider`.

An existing email never causes automatic merging. The user must sign in to the existing account and explicitly link the provider. GitHub email verification comes from `/user/emails`, including when a public profile email exists. A provider subject without a verified email can receive a passwordless account and an `oauth` session; its email is not invented or marked verified. Password login and password-session renewal still require verified email. Provider sessions remain usable only while their owned binding exists, and unlinking revokes that binding's sessions. The last available sign-in method cannot be removed.

The new migration adds `account_oauth_intents`, `account_oauth_proofs`, and session authentication/binding fields; existing sessions default to `password`. Proof claim, ownership checks, user creation and binding writes share the same PostgreSQL transaction. Provider-subject locks serialize competing accounts, user locks serialize connection changes, and unique indexes enforce both provider ownership and one binding per provider/user. No provider access or refresh token is stored. A later local session-issuance failure does not undo a committed identity handoff; start a fresh provider flow. Existing bindings make that retry safe without creating a second user.

`ApplicationDatabase.transaction` combines model operations with `ApplicationTransaction.query<TRow>(sql, values)`, returning `{ rows }`. SQL is fixed with parameters passed separately. Each transaction pins `search_path` to the connection URL's schema, so raw SQL and generated Prisma operations use the same namespace. Nested model transactions flatten onto that transaction; inherited transaction hooks remain intact.

`test/oauth.persistent.e2e-spec.ts` runs against an explicitly designated development/test database using a fresh random schema and cleans it afterwards. Provider-code exchanges are injected substitutes; One Tap tokens are locally signed and verified against a local JWKS substitute. Live consent screens, Google/GitHub app settings and production callbacks still need operator validation after configuring real provider applications. No provider application is created or enabled by these tests.

## Optional checkout and durable credit fulfillment

Billing is installed once at the application root. Every provider is disabled and the catalog is empty by default. Enable only a configured Stripe, PayPal or Creem adapter with its explicit environment, account scope and webhook verification settings. `BILLING_CATALOG_JSON` is application-owned configuration: each item supplies `id`, `title`, `version`, `mode`, exact decimal `amount`, `currency`, positive integer `credits`, optional `expiresInDays`, and provider catalog references. It is not a browser-supplied price. Changing configuration affects new orders; an existing order retains its original policy.

| Entry below `/api/billing` | Contract |
| --- | --- |
| `GET /catalog` | Public enabled offers and supported channels; no credentials or private fulfillment data |
| `POST /orders` | Authenticated selection containing only `offerId`, `providerId`, optional referral; requires trusted Origin and a stable `Idempotency-Key` of 16–128 letters, numbers, `_` or `-` |
| `GET /orders?page=1`, `GET /orders/:id` | Owner-scoped records and page totals; reads do not capture money |
| `POST /orders/:id/confirm` | Owner-scoped, read-only provider reconciliation; body `{}` or an optional untrusted `checkoutId` recovery hint; no payment capture |
| `POST /orders/:id/capture` | PayPal explicit approval only, body exactly `{ "approved": true }`; a persisted claim prevents automatic repeat capture |
| `GET /balance` | Current account balance and frozen balance |
| `POST /webhooks/:provider` | Public signature-verified raw-body notification, then provider re-read; event payloads alone never grant credits |

The Web template provides `/pricing`, `/billing/return?order=…`, and `/billing/orders`. Payment requests derive ownership from the authenticated session. Account origins and the bootstrap CORS policy include `Idempotency-Key`; changing to a separate frontend origin requires updating `ACCOUNT_ORIGINS`. HTTP failures expose fixed messages, not provider response bodies.

The billing migration adds persistent orders, fulfillment receipts, credit lots/consumptions/allocations, operation receipts and a fulfillment outbox. The order CAS, frozen-policy grant, lot, canonical credit account/journal, fulfillment and outbox share one actual PostgreSQL transaction. Concurrent callbacks grant once. The `BatchCreditLedger` adapter consumes these same lots under an account lock; do not independently mutate the legacy balance and treat that as a lot operation. The billing outbox retains durable fulfillment events; subscription reconciliation uses the shared JobsHost. Durable email delivery has a separate, explicitly configured delivery repository and is not automatically triggered by every billing event.

Create/capture failures remain reconcilable unknown outcomes. Retry the same order/key to inspect it; never generate a new order automatically to recover a lost response. A verified webhook or an owner-authenticated return hint can recover an unknown checkout after restart. The Server re-reads the provider and checks the original order reference, catalog, quantity and payment evidence before binding the hint. Without a recoverable provider identity, the order remains unresolved for operator reconciliation. Recovery does not replay a charge.

The template accepts one-time and subscription offers. Subscription checkout binds the local subscription and a durable reconciliation outbox; it does not independently grant initial credits. `SubscriptionCycleService` processes the initial and subsequent paid receipts through the same ledger transaction. Stripe/Creem use provider-proven periods. PayPal requires explicit `subscriptionGrantBasis: { "paypal": "payment" }` in the catalog because its receipt API does not prove a period; it grants once per actual payment and leaves period fields null. No guessed renewal dates are used.

`GET /api/billing/subscriptions`, `GET /:id`, `POST /:id/refresh`, `POST /:id/cancel`, `GET /:id/invoices` and `POST /:id/portal` expose only the authenticated owner's bound resources. Cancellation requires an explicit supported mode; its intent is claimed durably before provider I/O, and uncertain results are queried without replaying the command. Portal/invoice support follows each provider's capabilities. The Web entry is `/billing/subscriptions`.

`BillingRuntimeModule` registers reconciliation with the one `JobsHost`, including the checkout outbox. Task leases are checked under row locks inside each financial transaction, so an old executor cannot write after losing authority. Exhausted attempts become attention records instead of silently creating infinite replacement tasks. Explicit successful reconciliation clears the failed pointer. Late historical grants that are already expired are journaled and expired atomically.

Exact positive totals and one catalog item are required; trials, variable totals and automatic tax need their own explicit policy (promotions: see Account growth and security). Refund protocols, persistent commands and source-lot holds are now wired through the template controller; the refund section below records the accepted local runtime slice and the broader acceptance still in progress. Use that permission-protected workflow rather than calling a lower-level provider method from a button. No live payment or refund was executed for these checks.

`test/billing.persistent.e2e-spec.ts` verifies the real ledger transaction, rollback/concurrency and separate-process recovery. `test/billing.http.e2e-spec.ts` verifies the actual HTTP guards, CORS preflight, input validation, owner isolation, raw webhook body, read-only confirmation, explicit capture, error redaction and restart recovery. Both use disposable schemas in an explicitly configured development/test database and synthetic providers. They neither call live payment services nor establish published-artifact or production readiness.

## Account growth and security (Phase 3)

All entries are under `/api`, need a trusted `Origin` on writes and return `Cache-Control: private, no-store`.

| Feature | Entries | Notes |
| --- | --- | --- |
| Two-factor (TOTP) | `POST /authorize/login` may answer `{twoFactorRequired, challenge}`; finish with `POST /authorize/login/two-factor {challenge, code}` or `{challenge, recoveryCode}`. `GET/POST /authorize/two-factor/{status,enrol,confirm,disable,recovery-codes}` | Needs `CONFIG_ENCRYPTION_KEY` (secrets are encrypted with it; without it enrolment is refused and enrolled accounts get `503 TWO_FACTOR_UNAVAILABLE`). A code is accepted once (the last used step is advanced with a conditional update, so replay fails across instances); wrong codes and recovery codes count toward one lockout. Policy `account.twoFactorEnabled` stops new enrolment only. Operators reset a user's second factor from the back office (`users:update`, recent authentication, audited, the user is notified). |
| Magic link | `POST /authorize/magic-link {email}`, `POST /authorize/magic-link/consume {ticket}` | Off by default (`account.magicLinkEnabled`); existing accounts only (D17). Mail template `account.magic-link`. |
| Account deletion | `POST /authorize/deletion`, `POST /authorize/deletion/cancel` | 7-day grace (`account.deletionGraceDays`), then the `account.delete` job anonymises the user and keeps financial rows (D16). Every feature that stores personal data registers a contributor; the application list is `src/accounts/deletion/app-contributors.ts` (order asserted by `test/account-deletion-registry.unit.e2e-spec.ts`). Mail templates `account.deletion-scheduled`, `account.deletion-completed`. |
| Role expiry | `ZuckerAuthModule.forRoot({ roleAssignments: { expiry: true } })`, `pnpm account:role -- --expires <ISO>` | Expired role links grant nothing. |
| Notifications | `GET /inbox`, `GET /inbox/unread-count`, `POST /inbox/:id/read`, `POST /inbox/read-all`, `POST /inbox/:id/archive` | Committed billing/AI rows are scanned on the Jobs host (`inbox-events`, ~75 s latency); feedback replies and referral rewards post in their own transaction. A source that fails is retried without blocking the others; a row the inbox refuses is logged and passed. `INBOX_RETENTION_DAYS` (default 90). |
| Feedback | `POST /feedback` (Idempotency-Key), `GET /feedback/mine`, `/management/feedback` (`feedback:query`/`feedback:update`) | Policy `feedback.enabled`, `feedback.maxOpenPerUser`. |
| Promotions | `POST /billing/orders {…, promoCode?}`, `/management/promotions` (`promotions:*`) | Percent (1–99) or fixed amount, computed and frozen by the server; codes that bring the total to zero are refused (D11); subscriptions are discounted on the first invoice only (D10). Buyers type codes only when policy `billing.allowCustomerPromoCodes` is on. Stripe gets a single-use, `once` coupon with the server-computed **fixed** `amount_off` for each promoted session (never a percentage), so Stripe's total always equals the frozen payable; the promotion's `providerCode` is a label stored in the session metadata and reported back as the discount reference. PayPal and Creem refuse promotions. Receipts, the owner's order pages and the back-office order ledger show the amount charged, the discount and the list price; refunds are bounded by the amount charged. |
| Referrals | `GET /referrals/me`, `POST /referrals/claim`, `/management/referrals*` | Off by default (`referral.enabled`, D15); reward after a 7-day delay; self and mutual referrals are refused by the service and the database. |
| Insights | `GET /management/insights/summary`, `/series` (`insights:query`) | Read-only, 5 s statement timeout, 60 s cache; currencies are never summed. |

Upgrading an existing installation: `pnpm db:migrate` adds the Phase 3 tables, the back-office permissions and menus (only where the starter setup already ran), the mutual-referral trigger and the insights/inbox scan indexes (`20261111090000_insights_indexes`, plain `CREATE INDEX`: run it in a quiet period on large tables).

### Test-only fake payment provider

`BILLING_TEST_FAKE_PROVIDER=true` (refused when `NODE_ENV=production`) adds the in-memory `fake` provider for checkout, subscriptions and refunds and a hosted test page at `/api/billing/test-checkout/:id` (pay, cancel, resend webhook). Give a credit pack or plan price a `fake` provider reference through the back-office API (`providerRefs: { "fake": "any-ref" }`). State lives in one process and is lost on restart. It exists for local demos and the real-stack acceptance run only.

## Personal API keys

Authenticated users manage their own keys through `GET/POST /api/authorize/api-keys`, `PATCH /api/authorize/api-keys/:id` (name only) and `DELETE /api/authorize/api-keys/:id`. Creation accepts only a name, supported scopes and `expiresInDays` (7, 30, 90 or 365; default 30). Mutations require an allowed Origin. The one-time creation response contains the secret; only its SHA-256 hash is persisted, and lists never return the secret or hash. Responses are not cached and the key controller excludes request/response access logging.

The template currently grants only `account:read`, usable at `GET /api/v1/account` through `X-API-Key` or `Authorization: Bearer zk_api_…` headers; URL parameters are not accepted. It does not turn an API key into a login token or authorize account, billing, file or administrator mutations. This route explicitly delegates from the existing account guard to the public Framework API-key guard, then verifies the scope and current account status. Expired, revoked, inactive and disabled-account keys are denied. The sample policy is 60 requests per minute per key, using the configured rate-limiter provider; the default in-memory limiter is process-local, not a distributed or restart-persistent quota. New product APIs declare their own scopes and authorization policies.

Migration `20261024000400_account_api_keys` adds owner-bound key and usage tables. `test/api-keys.http.e2e-spec.ts` is the isolated PostgreSQL/HTTP verification entrypoint. The Web account page exposes the matching create, copy-once and revoke actions; treat a lost creation response as a key that must be revoked, never as a reason to retrieve its plaintext later.

## Private attachment storage and recovery

`FilesModule` uses the same `FILE_MANAGER` configured once at the root. Local storage is the development default. With `NODE_ENV=production`, startup requires `FILES_STORAGE_PROVIDER=s3` plus explicit private S3/R2 credentials; custom production endpoints must use HTTPS. The application does not create or change bucket permissions. `FILES_MAX_BYTES` can lower the 10 MiB buffer/upload ceiling. This entrypoint is a bounded attachment example; large objects need the existing streaming storage APIs and their own consumer upload policy.

| Entry below `/api/files` | Contract |
| --- | --- |
| `GET /` | Owner-scoped pagination and safe upload/import limits |
| `POST /` | One multipart `file` plus a stable `Idempotency-Key`; allowed Origin and session required |
| `POST /import` | Bounded HTTPS download from an explicit trusted-host allowlist, then private storage with the same request key |
| `POST /:id/download-url` | Owner-authorized short download ticket, default60s and maximum300s |
| `GET/POST /:id/download` | Purpose/session/credential/asset-bound ticket redemption; Web uses POST body to avoid URL logging |
| `GET /requests/:key` | Find the current user's reservation after an uncertain upload response |
| `GET /:id` | Owner-scoped metadata; no private object key or URL |
| `GET /:id/content` | Authorized, integrity-verified attachment bytes with `no-store`/`nosniff` |
| `DELETE /:id` | Persist a deletion tombstone before object cleanup |
| `POST /:id/recover` | Inspect the original object and finish pending metadata or retry deleted-object cleanup |

The file migration owns durable reservations, unique owner/request and object identities, revisions and permanent deletion tombstones. A file identity cannot be rebound by a metadata update. Reusing a key with different bytes/name/MIME is a conflict. Upload writes occur outside database transactions: after an uncertain result, inspect the original request and call `recover`; a pending record is not a downloadable success. Byte size/hash verification precedes readiness and every download. Deletion failures leave a persisted cleanup status; a late upload cannot resurrect the metadata.

There is no static `/uploads` endpoint, stored public URL, automatic recovery worker, retention scheduler or media product in this slice. `cleanupConfirmedAt` means absence was observed then, not that an in-flight remote upload can never finish later. A later recovery can remove such an object using its retained tombstone. `test/files.persistent.e2e-spec.ts` covers the PostgreSQL metadata and local object path; real R2/S3 canary evidence remains separate.

## Persistent public content

The consumer-owned `ContentModule` stores pages, blog posts, documentation and blog categories in
PostgreSQL (`site_content_entries` / `site_content_categories`). Apply the checked-in migrations,
including `20261024000800_site_content`. Public reads use `/api/content/public/*`; authoring uses
`/api/content/manage/*` and requires the explicit `content:manage` permission. No default editor
account, content record or automatic superadmin grant is created.

Creation saves a draft. Every update/publication action supplies `expectedRevision`; row locks and
revision checks reject stale/concurrent writes with 409. Draft and published JSON/slug fields are
separate, so saving a draft cannot change a live page, search result, metadata or URL. Publish copies
an independently validated visible snapshot, verifies same-language published category references,
and atomically updates search/publication projections. Unpublish/archive removes those projections.
Categories can be unpublished without withdrawing their posts; the public category link disappears,
and the post must remove the reference or restore the category before it can be republished.

The generic document/block contract comes from `@zucker-framework/fe-site/content`; CMS permissions,
locale/route restrictions, revisions, database schema and publication policy stay in this template.
Markdown rendering is a Web responsibility and never executes MDX or raw HTML. Native PostgreSQL
full-text search plus escaped literal matching supports English/CJK documentation. Sitemap reads
are paginated at 1000 records and exclude noIndex snapshots; public content failures return 503,
never fake empty data or local fallback posts.

`WEB_URL` is the trusted public site origin for canonical URLs and SEO. Content mutations use the
existing `ACCOUNT_ORIGINS` allowlist. Branding, theme/default appearance and bilingual public links
are validated and persisted in the dedicated ConfigService `site.publicSettings` key. Only those
public fields are projected; unrelated site-scope values are not exposed. Missing/invalid visual
settings fall back to explicit defaults; database content never falls back to samples.

Focused real persistence/HTTP tests: `pnpm exec vitest run --config vitest.e2e.config.ts test/content.persistent.e2e-spec.ts`
with an isolated `TEST_DATABASE_URL`. The opt-in `content.browser.e2e-spec.ts` additionally uses
`RUN_CONTENT_BROWSER=1`, the local Web template on `localhost:4319` and installed Chrome. Both use
synthetic accounts/content, random schemas and cleanup; no payment, AI, email provider or production
call is needed.

## Durable jobs, delivery and credit maintenance

`JobsModule` owns one host for task scans, outbox handoff, claims, heartbeats, recovery and shutdown.
`POST /api/jobs` submits the neutral record example with an owner-bound stable idempotency key;
`GET /api/jobs`, `GET /:id`, `GET /:id/record` and `POST /:id/cancel` keep ownership checks.
Internal billing/credit maintenance tasks are not user-cancelable; responses expose `canCancel`.
PostgreSQL is the task and event source of truth. Provider I/O remains outside ledger transactions.

Delivery requires an explicit `DELIVERY_PROVIDER` (`none`, `smtp` or `resend`) and its corresponding
profile. Recipient/template policy remains in the consumer. SMTP outcomes that may have been sent
are not replayed automatically. Resend's persisted first dispatch bounds replay to at most 23 hours
(`DELIVERY_REPLAY_WINDOW_MS` can shorten it); expired replay authority requires review.

`CreditsModule` reads the same source lots and canonical wallet journal used by billing.
`GET /api/credits/balance`, `/transactions` and `/lots` return owner-scoped views; the Web entry is
`/account/credits`. Expiry runs through the shared JobsHost. Optional record quota is independent
of credits: submission/reservation, completion/confirmation and cancellation/release each share a
transaction; limits changing after acceptance do not invalidate an existing reservation.

The focused PostgreSQL suites are `jobs.persistent`, `jobs.http`, `credits.persistent`, `credits.http`
and `billing-runtime.persistent` under `test/`; all require an explicit isolated test database.

### Data retention

`RetentionModule` purges API-key usage rows, access logs, revoked/expired sessions and completed
internal reconciliation jobs once per hour through the JobsHost (windows: `RETENTION_*_DAYS`, `0` keeps
a table forever). Each table is deleted in batches of `RETENTION_BATCH_SIZE` rows (default 1000), one
transaction per batch, until a batch comes back short or `RETENTION_MAX_BATCHES_PER_RUN` (default 50)
is reached. Raise the batch count temporarily to drain an existing backlog faster.

Deployment checklist for the `20261110000000_retention_indexes` migration: it uses plain
`CREATE INDEX IF NOT EXISTS`, which blocks writes to `account_api_key_usage`, `account_sessions` and
`async_jobs` while each index builds. When those tables are large, first create the three indexes with
`CREATE INDEX CONCURRENTLY IF NOT EXISTS` (statements in the migration file, run one at a time outside
a transaction while the application is up), confirm none is invalid
(`SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;` must not list them; drop and repeat
otherwise), then run `pnpm db:migrate`, which accepts the existing indexes.

## Management, readiness and audit privacy

The Admin template reads persistent orders, subscriptions, jobs, deliveries, files, credit records
and access logs through permission-protected `/api/management/*` projections. Private payloads,
provider metadata, recipient details, storage keys and credentials are not management-list fields.
Positive manual credit grants require `credit:grant`, a stable request key and an atomic journal
plus actor audit. Legacy memory-only notification/logging Admin controllers are not registered.
Site configuration edits use the persisted public settings consumed by Web.

`GET /api/health/ready` and `/api/health` check the actual consumer PostgreSQL schema; missing
required tables or dependency failure return 503. `/api/health/live` only checks process liveness.
Application database sessions use UTC, including direct model reads and raw transaction SQL.
The global access logger persists metadata while disabling request/response capture, even if a
controller opts in. Audit detail is not a complete unsampled HTTP traffic aggregate.
`test/application-health.persistent.e2e-spec.ts` checks the real AppModule, missing tables,
redacted dependency failures and persisted audit privacy. These local checks do not constitute a
published artifact, a live-provider certification or a production deployment.

## 管理范围查询与正向积分发放

`ManagementModule` 提供经过明确字段投影的管理查询：订单与支付渠道订阅（`/management/orders`、`/management/billing-subscriptions`，`billing:query`）、任务（`jobs:query`）、投递（`notification:query`）、文件（`files:query`）、日志（`logging:query`）、积分（`credit:query`）与 API 密钥元数据（`api-keys:query`）。这些查询与个人 owner-scoped 接口分开，支持有界分页和允许的 owner/status 过滤；密钥 hash/secret、私有支付策略、任务 payload、租约和存储键不会返回。

`POST /management/credits/:ownerId/grants` 另需 `credit:grant`、受信 Origin 和稳定 Idempotency-Key。仅接收正整数 amount、发放 description 和可选 expiresAt；actor 从认证上下文获得。canonical lot/balance/journal/operation receipt 与 actor 审计处于一个 PostgreSQL 事务，失败全回滚，不使用旧 CreditService 的仅余额写入。没有新增负调整或冻结接口。

`GET /management/connections` 需 `config:query`，共用实际 SDK 工厂的不可变 `RUNTIME_ENVIRONMENT`，仅检查本地配置来源、缺项与 SDK/解析可用性，不验证外部凭据或发送请求。`/management/connection-settings` 返回可保存 descriptor 与 stored/applied revision，写操作另需 `config:update`、可信 Origin 与 expectedRevision。独立配置加密密钥保护数据库值；保存不会热替换 SDK，重启 Server 后应用。各项附带稳定的 `labelKey`/`categoryKey`/`descriptionKey` 供后台翻译；新订单记录已应用的 `payment-*` 配置修订（`configRevision`）。账户/任务邮件仍使用实际配置与固定模板，不把旧内存模板服务当作可持久编辑功能。

## 套餐、权益、用户订阅、额度与邮件后台

`SubscriptionsModule` 与 `MailModule` 按 `docs/back-office-rfc.md` §8 装配 Framework 机制：

- 公开：`GET /billing/plans[?currency=USD]`（已上架套餐与价格列表；每个价格的 `purchasable`/`offerId`/`providers` 表示已启用渠道能否售卖该价格）、`GET /billing/entitlements/catalog`（附 `labelKey`）；登录：`GET /billing/entitlements/me`。
- 管理：`/management/plans`（`plans:*`）、`/management/subscriptions`（`subscriptions:query|update`，用户套餐订阅；支付渠道订阅记录改为 `/management/billing-subscriptions`）、`/management/quota-usage`、`/management/quota-reservations`（`quota:query|update`）、`/management/email-templates`、`/management/email-logs`（`mail:query|update`）。
- 功能目录在 `src/subscriptions/entitlement-catalog.ts`，是**产品自己的示例**：替换为本应用的功能、计数器与文案。套餐内容保存在 `subscription_plans`，价格保存在 `subscription_plan_prices`（月/年/一次性/终身 × 币种，金额为精确十进制文本）与 `subscription_plan_price_refs`（各渠道商品引用，全局唯一），每次写入按目录校验；`PUT` 可带 `expectedRevision` 防止并发覆盖。
- 套餐即商品：结账 `offerId` 为 `plan:<planId>:<interval>:<currency>` 时价格取自当时的套餐并冻结快照到订单；月/年走渠道订阅（需渠道能证明计费周期），一次性/终身为单次支付；套餐订单不发放积分。`BILLING_CATALOG_JSON` 仅作套餐种子：被套餐认领（同 slug）的订阅商品不再单独出售，未认领的订阅商品仍是纯积分订阅。
- `SubscriptionsService.chargeResource(userId, feature, { type, id }, work, { tx? })` 对计量功能按资源、按计数器只计一次：首次成功确认、失败释放、同一资源后续使用免费；另一请求正在使用同一资源时返回 409 `in_progress`；过期未清扫的预留在下次计费时转为 EXPIRED。`-1` 不限额度仍记录用量。计数器周期使用 `ENTITLEMENT_TIME_ZONE`（默认 UTC，仅在周期边界修改），预留有效期 `ENTITLEMENT_RESERVATION_TTL_MS`（默认 900000，须长于计量工作本身）。
- 支付回写：`SubscriptionsModule` 向 `BillingService` 注册套餐商品来源与履约钩子（`usePlanOffers`/`useFulfillmentHooks`，billing 不引用套餐代码）；在订单/周期履约事务内按订单冻结的 `planId` 写入 `user_subscription_payments` 与用户订阅，并写 `billing.plan-term-changed` outbox 事件。24 小时内的未结清套餐订单或仍在计费的套餐渠道订阅使后台修改期限返回 409，并给出阻塞的订单/订阅；撤销（`EXPIRED`）与取消只被渠道订阅阻止，撤销之后才付款的旧订单只记账（`revoked`）不复活期限。下单前拒绝付款后不会改善期限的购买（409，`result.details.refusal`），同一套餐的一次性期限叠加；渠道价格（Stripe Price、PayPal 订阅计划）与套餐价格不一致时下单返回 409。已付款但未改变期限的套餐支付写入 `billing.plan-payment-unapplied` outbox 事件，需在渠道后台退款。终身订阅不能取消，只能以 `EXPIRED` 撤销。套餐订单可经 `/billing/refunds` 按实付金额退款：某笔付款被全额退款时自动收回或缩短由它确定的期限（`billing.plan-term-changed`），部分退款保留期限。迁移 `20261109000000_back_office` 末尾的幂等数据步骤为升级库补齐后台权限行与新启动菜单。
- `pnpm account:admin` 首次初始化时把 `BILLING_CATALOG_JSON` 的订阅商品写成上架套餐（一个月付价格与该商品的渠道引用；无功能、无额度，待后台编辑）；之后不覆盖已存在的 slug。初始化同时补齐套餐、用户订阅、额度用量/预留、邮件模板/记录菜单与对应权限行。
- 邮件：账户邮件与 `MailService` 共用一个 `SmtpTransport`（连接配置 `account-email`）；`MailService` 使用 `email_templates`（`htmlContentEn` 必填、`htmlContentZh` 可选）与 `email_logs`；未配置时不发送。AI 模型目录（`createAIModelAdminController`）未接入：本模板通过运行时连接配置管理 AI，没有 `aiModels` 表与 `AIModelCatalogService`。
- 反向代理：设置 `TRUST_PROXY`（跳数或代理地址/CIDR），否则所有客户端共享代理地址的每 IP 限流；生产环境未设置时启动会告警。
- 迁移 `20261109000000_back_office` 新增上述表与 `billing_orders.configRevision`，允许额度 `limit = -1`，并用可空唯一列 `quota_reservations.activeResourceKey`（仅 RESERVED/CONFIRMED 行有值）替换原资源唯一约束，使失败释放或过期后可重新计费。PostgreSQL 验证见 `test/back-office.persistent.e2e-spec.ts`，后台表与 `schema.prisma` 的一致性由 `test/schema-drift.persistent.e2e-spec.ts` 守护。

## Refund requests and credit holds (local integration)

Current local checkpoint: the refund P1 is fixed and locally verified. Refunded-source credits remain unavailable when cash succeeds but source-hold creation or confirmation fails. Balance/lot projections distinguish refund-pending amounts from actual frozen credits; pending cash evidence is explicit in target inspection before another refund is allowed. I6 artifact sealing and independent consumer acceptance still await the root source-freeze checkpoint; these local results are not release evidence.

`BillingRefundsController` exposes administrator operations under `/api/billing/refunds`, all
requiring `billing:refund`. Lists and target inspection are read-only; mutations also require an
allowed Origin. `POST /` accepts a stable `Idempotency-Key`, a local order/cycle target, an exact
amount string and an optional reason. `POST /:id/check` and target checking only retrieve provider
facts. They never resend an uncertain refund command. The original payment remains a separate fact.

Source payment aliases bind an invoice/payment reference to its actual funding source. Signature-
verified events are stored even when they arrive before the local source mapping. Before granting
credits, checkout and cycle preparation retrieve refund evidence outside the ledger transaction;
the grant gate rechecks persisted restrictions under the account lock. Confirmed cumulative refunds
reduce credits using the frozen policy's integer cumulative ratio. A full refund before initial
fulfillment records a zero-credit fulfillment/outbox instead of granting later spendable credits.

Migration `20261024001000_credit_holds` adds source-lot holds and allocations. Uncertain refunds
retain their holds without an automatic release timeout. Consumption excludes held units; expiry
tracks free and held units separately, and a later release cannot revive expired credits. Existing
consumers with a nonzero scalar frozen balance but no attributable allocations must provide their
own proven migration mapping before enabling this store; the template rejects that inconsistency.
Migration `20261024001100_refunds` adds cash requests, source aliases, receipts, verified events and
independent reconciliation status. Do not delete those records or roll back schema while requests
or holds remain unresolved.

The single JobsHost performs bounded read-only refund reconciliation. Failed attempts stop with
`reconcileStatus=attention`; this does not rewrite a pending cash result as failed or imply an
insufficient-credit balance. A successful explicit check clears the old task pointer, so a late
failed worker cannot overwrite it. Task fences also protect financial writes after lease loss.
Customer order responses project a separate refund summary, including partial/full/pending cash
and attention, without exposing provider IDs, dispatch keys or private policy.

`test/refunds-runtime.persistent.e2e-spec.ts` verifies dual schedulers, no duplicate provider command,
lost-lease rejection, exhausted retries/manual recovery and full-refund-before-grant. Three Web
browser scenarios cover full, partial and pending refunds at 390px in English/Chinese. The broader
refund persistence/HTTP and Admin suites are separate acceptance inputs; this slice does not imply
that live providers, independent release artifacts or production have been verified.

## 通用 AI 连接装配

`AIConnectionsModule` 提供可注入的公共 `NativeAIClient`，复用 `AIConfigService`、调用包装器和现有native SDK工厂。
OpenAI、兼容接口、OpenRouter、DeepSeek、Anthropic、Gemini共6组连接默认关闭；后台加密保存后重启应用。
这里只验证本地参数/SDK构造，不发送提示词或凭据测试请求，不提供生成业务HTTP入口。
调用者选择明确的 `connection.*` 路由，或在 `aiModuleOptionsFromEnvironment` 的可选routes中声明自己的业务映射；
未知/关闭的连接失败，不回落旧数据库默认模型。业务仍负责提示词、权限、费用预算及成功定义。
详见 [AI连接](src/ai-connections/README.md)、[连接保存与重启](src/runtime-settings/README.md) 和 [私有文件](src/files/README.md)。

默认Web以POST正文兑换文件票据，并关闭Next自身原始请求URL日志；Server保留脱敏审计。
GET短链接供明确的临时分享使用。外部网关若记录完整查询串，需为这些短链接排除查询字段；本地Server/Next验证不代表外部代理配置已变更。
