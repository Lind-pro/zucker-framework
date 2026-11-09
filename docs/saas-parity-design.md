# AI-SaaS 快速起盘能力对齐设计

状态：设计稿，待维护者决策（§6）。日期：2026-11-09。

对标对象是一份商业 AI-SaaS 脚手架（下称"参考脚手架"）的**行为清单**，不是其代码。本文只从行为出发设计，并把清单中记录的弱点（内存限流、未签名回调被接受、后台动作缺服务端复核、硬编码 AI 价格、轮询式任务完成、静态 sitemap、多方言 ORM 垫片削弱事务语义等）按正确方式设计，而不是复刻。遵循[能力归属](architecture.md#新增能力的归属与接入)和正在实施的[通用后台 RFC](back-office-rfc.md)。所有路径相对本仓库；"现有"指当前工作区源码（1.0.17 基线，含未提交的后台工作），不等于已发布制品。

## 1. 目标、非目标与边界

**目标**：`zucker init`（server-full + admin + web）生成的三端在配置好数据库、Redis、对象存储和一组供应商凭据后，无需改库代码即可上线一个带账户、订阅/积分计费、后台、营销站与可选 AI 生成能力的 SaaS；产品只写业务 handler、套餐内容、文案和自己的页面。

**非目标**：不追求参考脚手架的单应用 Next.js 形态、多数据库方言、Cloudflare Workers 运行时、MDX 执行；不把任何产品的价格、Prompt、功能清单、邮件文案放进库；不承诺真实供应商账号、生产部署或制品发布（这些各自单独授权）。

**机制 vs 策略**（本文每个方案都按这条切分）：

| Framework 机制（packages/*） | 产品策略（消费者 / 模板中的产品示例） |
| --- | --- |
| 会话、OAuth 协议、API Key 鉴权、RBAC 通配匹配 | 注册开放政策、初始角色、注销宽限期 |
| 账本原子操作、到期/预留/一次计费、权益判定 | 套餐内容、价格、币种、赠送额度、AI 单价 |
| 支付协议、回调验签、幂等确认、退款、订阅周期 | 商品目录、允许的渠道、促销规则 |
| 连接配置描述符、加密存储、版本 CAS、公开字段投影 | 启用哪些供应商、环境值 |
| AI 调用包装、媒体任务生命周期、回调/轮询、冻结-确认-释放 | 模型目录、场景映射、Prompt、成本表 |
| 内容文档/区块 schema、主题解析、区块渲染器 | 落地页内容、品牌、主题 token、法务页 |
| 投递、邮件模板目录、发送记录 | 收件人、文案、触发时点 |
| 限流算法与分布式存储、出站 URL 安全检查 | 各接口预算、允许的外部主机 |

## 2. 能力矩阵

优先级：P0 = 没有它就不能"快速上线一个新 SaaS"；P1 = 上线后第一个月需要；P2 = 增长/体验项。"模板"指 templates/server、admin、web 中的消费者实现。

| 能力 | 现有覆盖（证据） | 缺口 | 建议归属 | 优先级 |
| --- | --- | --- | --- | --- |
| 邮箱密码注册/登录/验证/找回/改密 | 模板 `/authorize/*`，票据 SHA-256、凭据版本触发器（templates/server/src/accounts、README「账户协议」）；`auth` 的 `OneTimeTicketService`、`VerificationCodeService` | 账户邮件为固定文本（`account-mailer.ts`），未走 `MailService` 模板；无注册开关/初始角色/欢迎积分策略点 | 模板 accounts + `notification` 内置模板 | P0 |
| Google/GitHub OAuth、One Tap | 模板 `src/oauth`（PKCE、state、DB 票据、显式绑定）；`auth` 提供 code 交换与 ID token 校验 | 仅整页跳转，无弹窗模式；供应商仅两家 | `fe-auth` 弹窗助手（P2）；更多供应商按需 | P1（弹窗 P2） |
| 魔法链接 / Passkey / 2FA | `auth` 有 `TwoFactorService`、`TotpValidator`；模板未接 | 无魔法链接、Passkey；2FA 未装配 | 模板 accounts 接 2FA；魔法链接复用 `OneTimeTicketService` | P2 |
| 账户注销 | 无 | 无软删除/脱敏/会话撤销流程 | `auth` 增 `AccountDeletionService` 端口；模板策略 | P1 |
| 运行时设置（库表 KV、环境覆盖、公开白名单） | 模板 `runtime-settings`：16 个加密 profile、字段白名单描述符、来源标注、CAS 版本、审计（templates/server/src/runtime-settings/README.md）；`config` 的 `ConfigService`/`ConfigEncryptor`；公开端点 `/site/public/integrations`、`/content/public/settings` | 保存后须**重启**才生效（`appliesOn: 'server-restart'`）；描述符与存储逻辑在模板里，不可复用；公开白名单按 scope 而非字段 | 提取到 `config`（§3.1） | P0 |
| 价格页（分组、多币种、featured、当前套餐） | 模板 Web `/pricing` 读 `/billing/catalog`；后台套餐 `subscription_plans`、`/billing/plans`（back-office） | 价格页未读套餐表；无月/年切换、无功能对比、无多币种、无"当前套餐"标记 | `payment` plans 多价格；模板 Web | P0 |
| 结账服务端定价 | 模板只收 `offerId/providerId`，金额来自冻结目录（README「Optional checkout」） | 无促销码/折扣 | `payment` HostedCheckout 增 Stripe/Creem 促销选项 | P1 |
| 多支付渠道 + 用户选渠道 | Stripe/PayPal/Creem 托管结账、订阅、退款适配器（packages/payment/src/hosted-checkout、subscriptions、refunds）；Web 每张卡有渠道选择 | 渠道选择 UI 粗糙；"默认渠道/允许用户选择"开关缺 | 模板 Web + 连接描述符字段 | P1 |
| 幂等回调与回跳确认、乐观锁 | 原生回调验签 + 供应商回读，CAS 订单状态，同一 PG 事务发放（README「Optional checkout」；`billing.persistent/http` 测试） | 无 | — | 已完成 |
| 订阅（创建/续费/变更/取消/门户/发票） | `SubscriptionCycleService`、`/billing/subscriptions/*`，Stripe/Creem 门户，Stripe 发票 | PayPal 无门户、Creem 无发票（供应商限制，文档化即可） | — | 已完成 |
| 积分账本（到期批次、先到期先用、失败退回、欢迎积分） | `credit` 的 `BatchCreditLedger`（批次、hold/confirm/release、到期）、`PostgresCreditOperationCoordinator`；模板 `/credits/*`、后台正向发放 | `consume` 按 `createdAt` FIFO（packages/credit/src/batch-credit-ledger.ts:269），非先到期先用；无欢迎积分机制点；失败退回需由业务组合 hold/release | `credit` 消费顺序选项；欢迎积分在模板 accounts 用户创建 hook | P0 |
| 异步 AI 媒体生成（图/视频/音乐、轮询、回调、转存） | `ai` 的 `MediaGenerationService`（图、视频，`getTaskStatus` 轮询）、`AICallWrapper`；`task` 持久任务（租约、outbox、WAITING_PROVIDER）；`storage` 校验转存 | 三者未组合：无任务服务、无 HTTP 入口、无回调接收、无积分计量、无音乐供应商；成本表无归属 | 新包 `@zucker-framework/ai-tasks`（§3.3） | P0（AI 产品）/P1 |
| 流式 LLM 聊天 + 历史 | `NativeAIClient.chat/stream`（聚合流）；LangChain 入口有 `onTextDelta`；`fe-http-client` 有 SSE 读取；模板 `AIConnectionsModule` 仅装配 | 原生入口无逐块回调；无会话/消息模型、无 SSE 控制器、无计量 | `ai` 原生流增量；模板 chat 模块（§3.3） | P1 |
| RBAC 通配、角色到期、种子/指派脚本 | `PermissionService` 支持 `*`、`superadmin`、`resource:*`；`pnpm account:admin` 显式初始化 | `user_roles` 无到期字段（prisma/schema.prisma:251）；无"按邮箱指派角色"命令 | `auth` 可选 `expiresAt` + 判定；CLI/脚本 | P2 |
| 后台用户管理（角色、赠送积分） | `admin` users/roles/permissions 特性；`/management/credits/:ownerId/grants`（幂等、审计）；fe-admin users/credits 页 | 无负调整/冻结接口（已记录为后续项） | — | 已完成 |
| 后台只读财务视图 | `/management/orders`、`billing-subscriptions`、`credits`，字段投影；fe-admin 对应页 | 无 | — | 已完成 |
| JSON 驱动落地页 + 区块库 | `fe-site/content` 的 `SiteDocument` 与 6 种区块（hero/markdown/features/faq/cta/links，packages/fe-site/src/content.ts）；Web 首页为硬编码翻译键（templates/web/src/app/[locale]/page.tsx）；区块编辑是 JSON 文本框 | 区块种类不足；无渲染器包；首页不走 CMS；无表单化编辑 | 扩 `fe-site/content` schema；新包 `fe-blocks` 渲染器（§3.4） | P0 |
| 主题系统（回退、CSS token） | `resolveSiteTheme` 仅名称解析，注册表只有 `default`；Web 用 CSS 变量 + next-themes | 无主题包结构、无区块级覆盖与回退 | `fe-blocks` 主题注册表（§3.4） | P1 |
| i18n（as-needed 前缀、命名空间、回退、语言横幅、hreflang） | next-intl `as-needed`，zh/en；CMS 条目带 locale | 无 hreflang、无公开语言切换器、无语言建议横幅；大量内联三元文案 | 模板 Web | P1 |
| MDX 博客/文档/法务/更新日志；DB 与文件内容合并 | 模板 CMS：page/post/doc、草稿/发布、分类、PG 全文检索、sitemap 分页（templates/server/src/content；README「Persistent public content」） | 无仓内文件内容源（法务页、更新日志随代码版本管理）；无 `log` 类型；不执行 MDX（有意） | 模板 content 增 `FileContentSource` 与 `log` 类型（§3.4） | P1 |
| 后台 CMS（文章、分类、编辑器） | admin 模板 `/content`、`/content/categories`、`/config`（templates/admin/src/pages） | 区块仍是 JSON；无图片上传到封面 | admin 模板表单化区块编辑 | P1 |
| 用户控制台（资料、账单、订单、积分、任务、聊天） | Web `/account`（资料/密码/会话/头像/API Key/绑定）、`/account/credits`、`/account/files`、`/billing/*` | 无 AI 任务页、聊天历史页；`/dashboard` 仅重定向；无用量图 | 模板 Web（随 §3.3） | P1 |
| API Key 真正用于鉴权 | `auth` `ApiKeyGuard` + 模板 `GET /v1/account`（`account:read` 作用域，60/min） | 作用域仅示例；产品 API 如何声明作用域缺指引 | 模板示例 `ai:generate` 作用域 + 文档 | P1 |
| SEO（canonical、OG/Twitter、robots、hreflang、sitemap） | CMS 页有 canonical/OG；动态 `sitemap.xml` 索引 + 分页；`robots.txt` 生成 | 首页/价格页无 canonical/OG；无 OG 图生成；无 hreflang | 模板 Web `generateMetadata` 统一 + `opengraph-image` | P0 |
| 分析插件（GA/Clarity/Plausible/OpenPanel/Vercel） | `fe-analytics/site-analytics` 描述符 + Web `SiteAnalytics`，Server 公开投影 | 无 | — | 已完成 |
| 广告 + ads.txt | `fe-site` AdSense + Web `/ads.txt` | 无 | — | 已完成 |
| 联盟（Affonso/PromoteKit → 结账 metadata） | `fe-site` referral 读取/复核 → `providerMetadata` | 无内建推荐计划 | 内建推荐见 P2 行 | 已完成 |
| 客服挂件 | `fe-site` Crisp/tawk | 无 | — | 已完成 |
| 对象存储（R2/S3、内容哈希去重） | `storage` Local/S3(含 R2 端点)/WebDAV、`PrivateFileAssetService`；模板私有文件、票据下载 | 无公开 URL 资产类型（头像/封面/AI 产物需公开可读）；去重按请求键而非内容哈希；无预签名直传 | `storage` 公开资产模式 + 内容哈希索引端口；预签名 PUT | P1 |
| 事务邮件（Resend/SMTP） | `notification` SMTP/Resend、`MailService` 模板目录、`email_logs`；模板 `MailModule` 已装配但 `builtIns: []` | 无内置账户邮件模板；无收据/欢迎邮件 | `notification` 内置模板集 + 模板装配 | P0 |
| SSRF 安全的鉴权文件代理 | core `assertAllowedOutboundUrl`（精确主机白名单、仅 443、拒绝 IP 字面量/重定向）用于 `/files/import` | 无 DNS 解析后私网地址拦截；无通用下载代理 | `core`/`network` 增 DNS 判定（§4）；AI 产物转存后无需任意代理 | P1 |
| 公开页 CDN 缓存 | Web 全部 `no-store`，sitemap/robots `force-dynamic` | 无 s-maxage/SWR、无按标签失效 | 模板 Web + Server 发布后失效钩子（§3.4） | P1 |
| 多数据库（PG/MySQL/SQLite/D1） | Prisma + PostgreSQL；原生 SQL（`SKIP LOCKED`、advisory lock、触发器、FTS） | 不支持其他方言 | **不做**（§3.7） | — |
| 多目标部署（Vercel、Docker+CI、Cloudflare） | Web `output: standalone`（非 Vercel 时）；Server/Admin 无 Dockerfile、无 compose、无 CI 工作流 | 全部缺 | 模板 + CLI（§3.7） | P0 |
| UTM/IP/locale 采集 | 模板记录 locale、登录历史 IP | 无 UTM 采集与脱敏 | 模板 accounts | P2 |
| 会话轮询限流 | `rate-limiter` Memory/Redis（rate-limiter-flexible）；模板各控制器 `@RateLimit`，但存储为内存、`login` 预算未使用 | 非分布式默认；AI/聊天/上传/结账无单独预算 | 模板默认 Redis 存储 + 预算表（§4） | P0 |
| 多币种套餐 | 套餐 `prices[]`（月/年/一次性/终身 × 币种，Phase 0 已完成） | `/billing/plans` 访客币种默认值与 `current` 标记 | `payment` plans（§3.2） | P1 |
| 促销码/优惠券管理 | 无（CNIPA 有产品实现，RFC §5 记为后续提取） | 无 | P2 评估提取 | P2 |
| 反馈 | 无 | 无模型、无表单、无后台 | 模板 `FeedbackModule` + `createReadOnlyAdminController` + fe-admin `extraPages` | P1 |
| 站内通知 | `notification` 有 `NotificationInbox` 端口 | 模板/Web 未接 | 模板 + Web | P2 |
| 内建推荐计划 | 无 | 推荐码、归因、奖励发放 | 先做模板模块，有第二消费者再提取 | P2 |
| 经营看板 | `admin` dashboard 仅计数 | 无收入/用量聚合 | 模板只读聚合视图 | P2 |
| AI 辅助初始化（品牌快速改写等） | CLI 安装消费者 `AGENTS.md`（`cli/tooling/agent-instructions.mjs`） | 无"品牌/文案一键改写"技能 | CLI 消费者技能 | P2 |

## 3. 主要缺口的架构方案

### 3.1 运行时设置：热生效、环境覆盖与密钥处理

现状机制已经正确（加密存储、字段白名单、来源标注、CAS、审计、密钥不回显），问题是它活在模板里且只能重启生效。方案：

1. **提取到 `@zucker-framework/config`**（新子入口 `config/connections`）：`ConnectionDescriptor`（`id, group, fields[{key, kind:'text'|'secret'|'switch'|'url'|'json', public?: boolean, validate}], assemble(env) => options | issues`）、`ConnectionProfileStore`（加密 JSON profile、`expectedRevision` CAS、同事务审计端口）、`ConnectionRuntime`（解析顺序：**环境变量覆盖 > 已保存值 > 默认**；`null` 显式屏蔽环境值——与现有语义一致；参考脚手架是"环境覆盖 DB"，我们保留现有"保存覆盖环境、可清除"并额外提供 `pinnedByEnvironment` 字段级锁定，运维可在环境里钉死某字段，后台显示只读）。
2. **每个能力包导出自己的描述符**：`payment` 导出 stripe/paypal/creem，`auth` 导出 google/github，`notification` 导出 smtp/resend，`storage` 导出 s3，`ai` 导出六组原生连接，`fe-analytics`/`fe-site` 已是纯解析器。模板组合根只注册描述符数组，依赖图保持无环（`config` 不依赖这些包，只持有类型）。
3. **热生效分级**：描述符声明 `applyMode: 'hot' | 'restart'`。`hot`（分析、广告、客服、OAuth client、邮件、AI key、存储读）通过 `RuntimeProviderSlot<T>`：保存提交后发布 `CONFIG_CHANGED_TOPIC`，slot 在下一次 `get()` 按 `storedRevision` 重建实例并原子替换，`appliedRevision` 随之更新；`restart`（支付适配器）保持现状，因为既有订单/退款绑定账户身份，运行中切换会让核对走错账户。后台页面按 `pendingRestart` 显示。
4. **公开白名单按字段**：`public: true` 的字段聚合成 `GET /site/public/integrations`（已存在）的通用版本 `GET /site/public/config`，响应只含公开字段与版本号；`secret` 字段在任何响应中只返回 `{configured, source}`。缓存：Server 侧 `CacheService.getOrSet` + 保存时失效；Web 侧 `revalidate` 标签（§3.4）。
5. **产品级开关**（注册开放、邮箱验证必需、初始角色、欢迎积分、允许用户选渠道、默认渠道）作为模板自己的 `account-policy`/`billing-policy` 两个描述符注入同一机制，策略值仍归产品。

### 3.2 支付、套餐与积分补齐

- `payment` plans 已在 Phase 0 改为 `prices: [{interval:'month'|'year'|'one_time'|'lifetime', currency, amount, termDays, providerRefs}]`（子表 `subscription_plan_prices`/`subscription_plan_price_refs`，无旧列兼容投影），套餐即结账商品，订单冻结套餐/价格快照并记录 `configRevision`；`GET /billing/plans` 返回按访客币种过滤的价格与 `current: boolean`（登录时由 `user_subscriptions` 判定）。Web 价格页改读 `/billing/plans`，分组标签、月/年切换、功能矩阵（来自权益目录）。
- `HostedCheckoutService.create` 增 `promotion?: { allowCustomerCodes?: boolean; presetCode?: string }`，Stripe/Creem 适配器映射到各自官方字段，PayPal 不支持则拒绝（不静默忽略）。促销规则是产品数据（后台套餐页字段）。
- `credit`：`BatchCreditLedger` 增 `consumeOrder: 'expiry_first' | 'fifo'`，排序 `expiresAt ASC NULLS LAST, createdAt ASC`，PG 契约测试覆盖并发与到期边界；默认值见 §6。欢迎积分：模板 accounts 在用户创建事务后发布 `account.created`，`WelcomeGrantHandler` 以 `welcome:<userId>` 幂等键走 canonical ledger，金额/有效期/开关来自 §3.1 的 `account-policy` 描述符。
- 失败退回：§3.3 的任务服务用 hold → confirm/release 实现，不另写"退款"代码路径。

### 3.3 AI：媒体任务、聊天与计量

新包 `@zucker-framework/ai-tasks`（依赖 `ai`、`task`、`credit` 的端口类型、`storage` 的转存函数；不依赖 Nest 之外的任何消费者类型）。理由：Copyright 的 Dossier 流水线与新模板都需要"供应商异步任务 + 账本冻结"的同一组合，且其不变量（同事务写任务/outbox/hold、租约围栏、回调不可信）属于可靠性契约，不适合留在模板复制。

契约：
- `AITaskService.submit(tx, { ownerId, kind:'image'|'video'|'audio'|'text', providerId, model, input, idempotencyKey, cost })`：同一事务内 `PostgresTaskSubmitter` 写任务+outbox，`BatchCreditLedger.hold(cost)`；余额不足抛 `InsufficientCreditsError`。成本由消费者实现的 `AICostResolver` 端口给出（可读 §3.1 的 `ai-pricing` 产品描述符），库不含价格表。
- Worker（`DurableWorkerRuntime`）：`AICallWrapper.callWithRetry(provider.generate)` → 得到供应商任务 ID 进入 `WAITING_PROVIDER`，记录 `nextPollAt`（指数退避，上限由消费者配置）。
- **回调 + 轮询并存**：`POST /ai/tasks/callbacks/:provider` 由 `AIProviderCallbackVerifier` 验签；无签名方案的供应商回调只当作"唤醒提示"——仅触发一次立即轮询，**从不**用回调正文写结果。完成后 `transferVerifiedObject` 转存到应用存储（可选开关），再 `confirmHold`；失败/取消 `releaseHold`，终态写入与租约围栏在同一事务（RFC 保证 8–11）。
- 聚合读模型 `AITaskReader`（owner 过滤、按 kind 分页、字段投影不含供应商原始响应）；管理端用 `createReadOnlyAdminController({ projection })`。
- 音乐：在 `ai` 增 `AudioGenerationProvider` 接口（`MediaType.AUDIO` 已存在），第一个适配器以通用"异步任务 + 轮询"HTTP 协议实现，供应商具体端点由连接描述符配置。
- 聊天：`ai` 原生入口补 `stream({ onTextDelta, onReasoningDelta })`；模板 `ChatModule` 持有 `chats/chat_messages` 表、`POST /chat/:id/messages` 返回 SSE（Web 用 `fe-http-client` 的 `readSseStream`），每条助手消息按 token 用量通过 `AICostResolver` 计量并 `consume`（参考脚手架聊天不计费是弱点，这里默认计费、可配置为 0）。"联网搜索"开关只有在接入了工具时才显示。
- Web：生成器页（按 kind）、任务列表、聊天页；Admin：ai-tasks、chats 只读页经 fe-admin `extraPages` 注入。

### 3.4 营销站：区块、主题、内容与 SEO

- `fe-site/content` schema 扩到 v2：新增 `pricing`（引用套餐 slug，价格仍由 `/billing/plans` 提供，不在文档内写价）、`testimonials`、`logo-cloud`、`stats`、`steps`、`showcase`、`newsletter`（POST 到配置的动作 URL）、`blog-list`、`changelog`；每块 `enabled`、`variant`。v1 文档继续通过 `validateSiteDocument` 升级。
- 新包 `@zucker-framework/fe-blocks`（peer React 19；无 Next 依赖）：`BlockRenderer({document, theme, resolvers})`、`defineTheme({ name, blocks: {hero: Component,...}, tokens })`、`resolveThemeBlock(theme, name)` 按 **主题 → default 主题** 回退，缺块时记录 issue 并跳过。样式用 CSS 变量 token + Tailwind 类；`default` 主题随包提供。Next 专属部分（`generateMetadata` 助手、`opengraph-image`、hreflang 构造）留在 Web 模板，不进包。
- 首页改为 CMS `page` 文档（slug `home`，按 locale）；CLI 初始化时写入种子文档；CMS 不可用返回 503 而非回退样例（与现有原则一致）。
- 文件内容源：模板 content 增 `FileContentSource`（仓内 `content/{pages,posts,logs}/*.{locale}.md`，构建时读取），与 DB 条目合并，**slug 冲突 DB 优先**；新增 kind `log` 供更新日志页。继续不执行 MDX/原始 HTML（§6 决策 4）。
- i18n：`generateMetadata` 统一产出 canonical + `alternates.languages`（hreflang）+ OG/Twitter；公开 Header 加语言切换器；可选"切换到浏览器语言"横幅（一天内记住关闭，仅 cookie，不写用户）；清理内联三元文案进 `messages/*.json` 命名空间。
- 缓存：公开页读取改 `fetch(..., { next: { tags: ['content', slug] }, revalidate: 3600 })`，Server 发布/下线/站点设置保存后调用 Web 的 `POST /api/revalidate`（共享密钥 HMAC，验签失败 401），`proxy.ts` 为公开路径设置 `Cache-Control: public, s-maxage=3600, stale-while-revalidate=14400` 且公开路径不写 Cookie；账户/账单/管理路径保持 `no-store`。

### 3.5 用户控制台、API Key、注销、反馈

- 控制台：复用现有账户页，新增任务（§3.3）、聊天历史、用量摘要（来自账本与任务读模型，不另造统计表）。
- API Key：机制已完整（哈希存储、作用域、`ApiKeyGuard`、限流）。补：模板示例作用域 `ai:generate` 保护 `POST /v1/ai/tasks`，文档写明"新 API 声明作用域 + 复用 guard"。
- 注销：`auth` 增 `AccountDeletionService`（端口：锁用户、撤销全部会话与 API Key、解绑 OAuth、写 `deletedAt`、脱敏 PII 字段列表由消费者给出），模板策略：宽限 N 天可撤销、有未结清订阅时拒绝。
- 反馈：模板 `FeedbackModule`（`feedback` 表：owner、类型、内容、页面、状态；`POST /feedback` 走 `api-default` 预算与 Origin 检查）；后台 `createReadOnlyAdminController` + 状态更新动作；fe-admin `extraPages`。无需新包。

### 3.6 推荐计划、通知（P2）

- 内建推荐：模板模块（推荐码表、`?ref=` 采集 → 脱敏 cookie → 注册时绑定、首付成功事件后以幂等键发放奖励）。外部联盟（Affonso/PromoteKit）已由 `fe-site` 覆盖，两者互斥配置。有第二个消费者再提取。
- 站内通知：接 `notification` 的 `NotificationInbox` 端口到模板表，Web 头部未读数；邮件广播继续用 `MailCampaignService`。

### 3.7 部署目标与数据库可移植性

- **数据库：保持 Prisma + PostgreSQL，不做多方言。** 账本、任务、文件、退款的保证依赖行锁、`SKIP LOCKED`、advisory lock、触发器和 FTS；参考脚手架的方言垫片把 SQLite 行锁变成空操作、把 D1 事务变成顺序语句，正是要避免的行为。廉价托管用托管 PG（Neon/Supabase/RDS 等）；多项目共库用已有 `search_path` schema 隔离。
- **Server**：模板增 `Dockerfile`（多阶段、Node 24 Alpine、非 root、`prisma migrate deploy` 作为显式入口命令而非启动副作用）、`docker-compose.yml`（PG、Redis、MinIO、三端）、`.github/workflows/image.yml` 示例（构建推送 GHCR，需产品自己授权启用）。
- **Web**：Vercel 支持仅限 Web（`API_URL` 指向托管 Server；已有 `VERCEL` 判定），提供 `vercel.json` 示例；Docker standalone 镜像。**Cloudflare Workers 不作为目标**：NestJS、Prisma pg 驱动、BullMQ/Redis、Playwright 均不运行在 Workers；Web 层 OpenNext 可行但不在本计划承诺。
- **Admin**：静态镜像（nginx，SPA 回退 + `/api` 反代）。
- **CLI**：`zucker create <name>` 一次生成三端 + compose + 一致的 `.env`（随机 JWT/加密密钥、端口、`ACCOUNT_ORIGINS`）；`add payment`；`doctor` 检查 PG 连通、Redis、schema 就绪、密钥长度、公开 URL 一致性。

## 4. 安全验收标准（每阶段必须保持）

1. **每个写动作服务端授权**：后台与控制台的所有变更接口由 `PermissionsGuard`/所有权检查在接口内判定，不信任页面状态；测试：以 viewer 角色直接调用每个 `POST/PUT/PATCH/DELETE /management/*` 得 403；跨用户访问 `/ai/tasks/:id`、`/chat/:id`、`/files/:id`、`/billing/orders/:id` 得 404/403。
2. **所有供应商回调验签、失败即拒绝**：Stripe/Creem/PayPal 已 fail-closed（packages/payment/src/providers/paypal.spec.ts:54）；AI 回调同样，无签名方案只能触发轮询。测试：篡改签名、缺头、重放旧时间戳均 4xx 且无状态变化；回调正文伪造"成功"不发放积分、不写结果。
3. **出站请求 SSRF 安全**：`assertAllowedOutboundUrl` 增 DNS 解析后拒绝私网/环回/链路本地/CGNAT/ULA/多播地址并对解析结果固定连接；仅 https、禁重定向、主机白名单仍生效。适用于文件导入、AI 产物转存、Webhook 投递。测试：`127.0.0.1`、`169.254.169.254`、解析到私网的域名、`http://`、重定向到私网均拒绝。
4. **分布式限流**：模板在配置 `REDIS_URL` 时默认 Redis 存储，未配置时明确告警"进程本地"；`login`（5/15min/IP+账号）、`accounts`、`billing`、`ai-submit`（按用户）、`chat`（按用户）、`upload`、`feedback` 各有预算；测试：两个进程共享 Redis 时总预算只计一次。
5. **秘密不进浏览器**：描述符 `secret` 字段任何响应只返回 `{configured, source}`；公开端点只含 `public: true` 字段；Web 服务端组件不把 `API_URL` 以外的环境值注入客户端 bundle。测试：扫描 `/site/public/*`、`/management/connection-settings` 响应与 Web 构建产物无密钥模式；fe-admin 浏览器用例确认 DOM/存储无密钥（已有 `connections.browser` 用例延续）。
6. **幂等与并发**：结账、积分发放、任务提交、推荐奖励、欢迎积分均带幂等键，PG 契约测试做并发重放只生效一次。
7. **输入校验**：`ValidationPipe` 开启 `whitelist + forbidNonWhitelisted`（当前 TODO，templates/server/src/main.ts:24）；CMS 继续禁用原始 HTML/MDX。
8. **审计**：后台写操作在同事务写 `operationLogs`（含 actor、目标、字段名，不含值）；密钥变更只记字段名。

## 5. 分阶段实施计划

每个工作包可由一名实施者独立完成；验收列"单元 / PG 契约 / 浏览器"三类。

### Phase 0：完成并集成通用后台（进行中）

| 包 | 范围 | 触及 | 验收 | 依赖 |
| --- | --- | --- | --- | --- |
| 0.1 | `credit` EntitlementService、ResourceChargeService、周期键 | packages/credit | 单元；`back-office.persistent`（预留/确认/释放并发） | — |
| 0.2 | `payment` PlanCatalogStore、SubscriptionAssignmentService | packages/payment | 单元；PG 契约（指派 vs 支付回写冲突 409） | — |
| 0.3 | `admin` 套餐/订阅/额度/邮件记录工厂 + 字段投影 | packages/admin | 单元（权限、投影不泄漏） | 0.1、0.2 |
| 0.4 | `fe-admin` 全部页面与 `createAdminApp` 配置化 | packages/fe-admin | 组件测试；浏览器（登录、菜单权限过滤、16 个连接 profile、390px） | 0.3 |
| 0.5 | 模板接入：server `SubscriptionsModule/MailModule` 已装配；admin 模板切到 fe-admin（当前未提交删除/新增需收口）；修正 Playwright 端口（4101/3100 → 4202/4201）；接上 `login` 限流预算；开启 ValidationPipe 白名单 | templates/server、templates/admin、playwright.config.ts | `management.browser`、`back-office.persistent` 全绿；admin lint/build | 0.4 |
| 0.6 | 发布 1.0.18 批次（需授权）；更新 saas-quickstart | 全部 | 固定 tarball 消费验证 | 0.5 |

### Phase 1：上线基线（P0）

| 包 | 范围 | 触及 | 验收 | 依赖 |
| --- | --- | --- | --- | --- |
| 1.1 | `config/connections`：描述符类型、ProfileStore、Runtime、字段级 public、`applyMode`、`RuntimeProviderSlot`；各能力包导出描述符；模板 runtime-settings 改为组合 | config、payment、auth、notification、storage、ai、templates/server | 单元（优先级解析、`null` 屏蔽、钉死）；PG 契约（CAS 冲突、审计同事务）；浏览器（保存 hot profile 无重启生效、restart profile 显示 pendingRestart） | 0.6 |
| 1.2 | 产品策略描述符 `account-policy`/`billing-policy`；欢迎积分 hook；注册开关；初始角色 | templates/server accounts | PG 契约（欢迎积分幂等、关闭时不发放） | 1.1 |
| 1.3 | `notification` 内置账户模板（验证、找回、欢迎、收据）+ 模板 `MailModule` 装配、账户邮件改走 `MailService` | notification、templates/server | 单元（渲染/变量）；PG（`email_logs` 写入）；合成 SMTP 端到端 | 0.6 |
| 1.4 | `credit` `consumeOrder`；PG 契约 | credit | PG（到期顺序、并发） | 0.6 |
| 1.5 | 套餐多价格 + 促销选项；`/billing/plans` 币种过滤与 `current`；Web 价格页重做（分组、月/年、功能矩阵、渠道选择、当前套餐） | payment、templates/server、templates/web | 单元（适配器映射、PayPal 拒绝促销）；PG；浏览器（切换、下单幂等键、空状态） | 0.6 |
| 1.6 | Redis 限流默认 + 预算表；DNS 级 SSRF 判定 | templates/server、core/network | 单元（地址分类）；双进程契约 | 0.6 |
| 1.7 | SEO 统一：`generateMetadata` 助手、hreflang、OG 图路由、首页/价格页 canonical | templates/web | 单元（元数据快照）；浏览器（`<link rel=alternate>`、OG 图 200） | 0.6 |
| 1.8 | 部署：三端 Dockerfile、compose、GHCR 工作流示例、`vercel.json`、文档；CLI `create`/`add payment`/`doctor` 扩展 | templates/*、packages/cli | 本地 compose 起三端 + `health/ready` 为真；CLI 单元（生成文件、密钥随机、端口一致） | 0.6 |

### Phase 2：AI 产品层（P0 for AI / P1）

| 包 | 范围 | 触及 | 验收 | 依赖 |
| --- | --- | --- | --- | --- |
| 2.1 | `ai` 原生流增量回调；`AudioGenerationProvider` 接口 + 一个通用异步适配器；`AIProviderCallbackVerifier` 接口 | ai | 单元（VCR 固件、取消传播） | 0.6 |
| 2.2 | 新包 `ai-tasks`：submit/worker/poll/callback/transfer/hold 生命周期、读模型 | ai-tasks（新） | 单元（状态机）；PG 契约（同事务提交、余额不足回滚、失败释放、过期租约拒写、回调伪造无效、并发回调一次） | 2.1、1.4 |
| 2.3 | 模板：`AITasksModule`（HTTP、回调路由、`AICostResolver` 读 `ai-pricing` 描述符）、`ChatModule`（SSE、计量） | templates/server | HTTP 契约（所有权、限流、API Key 作用域 `ai:generate`） | 2.2、1.1、1.6 |
| 2.4 | Web 生成器/任务/聊天页；Admin ai-tasks/chats 只读页 | templates/web、templates/admin | 浏览器（合成供应商：提交→轮询→完成→下载；失败退回余额；聊天流式渲染） | 2.3 |

### Phase 3：营销站（P0/P1）

| 包 | 范围 | 触及 | 验收 | 依赖 |
| --- | --- | --- | --- | --- |
| 3.1 | `fe-site/content` v2 区块 schema 与升级 | fe-site | 单元（校验、v1→v2、禁用块过滤） | 0.6 |
| 3.2 | 新包 `fe-blocks`：渲染器、主题注册表与回退、default 主题 | fe-blocks（新） | 组件测试（缺块跳过、回退、token） | 3.1 |
| 3.3 | Web：首页走 CMS、`FileContentSource`、`log` 类型、语言切换器/横幅、文案进 JSON、缓存标签与 `/api/revalidate`、`proxy.ts` 缓存头 | templates/web、templates/server content | PG（slug 冲突 DB 优先）；浏览器（发布后失效、公开页无 Set-Cookie、hreflang） | 3.2、1.7 |
| 3.4 | Admin 区块表单化编辑、封面上传 | templates/admin | 浏览器（草稿/发布/冲突） | 3.1 |

### Phase 4：账户与增长（P1/P2）

| 包 | 范围 | 触及 | 验收 | 依赖 |
| --- | --- | --- | --- | --- |
| 4.1 | `auth` AccountDeletionService + 模板注销流程 | auth、templates/server、web | PG（会话/密钥撤销、宽限撤销） | 0.6 |
| 4.2 | 反馈模块 + 后台 | templates/server、admin | HTTP（限流、Origin）；浏览器 | 0.4 |
| 4.3 | 公开资产模式 + 内容哈希去重端口 + 预签名 PUT | storage、templates/server | PG（哈希命中复用）；S3 合成 | 0.6 |
| 4.4 | 推荐计划、站内通知、2FA 装配、角色到期、UTM 采集、经营看板 | 按项 | 按项 | 1.x |

## 6. 待维护者决策（建议项加粗）

1. **热生效范围**：全部 profile 热生效 / **分级（非财务热生效，支付适配器仍需重启）** / 保持全部重启。建议分级：既有订单与退款绑定账户身份，运行中切换支付账户会让核对走错账户。
2. **AI 任务组合的归属**：**新包 `@zucker-framework/ai-tasks`** / `ai` 的 `./tasks` 子入口 / 留在模板。建议新包：依赖 `task` 与账本端口、有两个消费者（Copyright Dossier、新模板）、不变量属于可靠性契约。
3. **区块渲染器归属**：**新包 `fe-blocks`（peer React）** / `fe-site` 子入口。建议新包：`fe-site` 承诺零运行时依赖且被 Server 端用于纯校验，不应引入 React peer。
4. **MDX**：**不引入**，保持 Markdown + 结构化区块 + 仓内 Markdown 文件源。理由：MDX 执行内容中的代码，与"内容永不执行 HTML/MDX"的安全基线冲突；参考脚手架的 MDX 价值（文档站、法务页、更新日志）由文件内容源与 `doc`/`log` 类型覆盖。
5. **数据库与部署目标**：**仅 PostgreSQL；Docker 为主、Vercel 仅 Web、不承诺 Cloudflare Workers**。理由见 §3.7。
6. **积分消费顺序默认值**：**新模板默认 `expiry_first`，库默认保持 `fifo` 以免改变 Copyright 现有账本行为**，由组合根显式选择。替代：库默认改为 `expiry_first` 并要求 Copyright 升级时评估。

## 7. 维护者决策（2026-11-09，已确认）

1. **热应用范围：全部热应用，包括支付。** 未采用"支付需重启"的建议，因此支付适配器切换必须保证：订单创建时记录所用连接配置的版本（revision）；该订单的回调签名校验、查询与退款一律按订单记录的版本解析凭据；新配置只用于此后新建的订单；旧版本凭据在仍有未结订单引用期间保留（加密存储，不下发浏览器），全部结清后方可清除。验收需覆盖"切换期间旧订单回调成功、新订单使用新配置、伪造版本被拒绝"。
2. **AI 任务与区块渲染：新建 `@zucker-framework/ai-tasks` 与 `@zucker-framework/fe-blocks`**；`fe-site` 保持零依赖。
3. **内容：不引入 MDX**，使用 Markdown + 区块 + 文件内容源（同 slug 时数据库优先）。
4. **数据库与部署：仅 PostgreSQL；server/admin 以 Docker 部署，Web 可部署到 Vercel；不支持 Cloudflare Workers。**
5. **积分消耗顺序：模板默认 `expiry_first`，库默认保持 `fifo`**（不改变现有消费者账本行为）。
