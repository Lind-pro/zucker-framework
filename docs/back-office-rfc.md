# 通用后台（Back Office）设计

状态：已确认方向，实施中。日期：2026-11-09。

目标：新产品通过 `zucker create`（server + admin 模板）直接获得一套可用的后台——登录与会话、用户/角色/权限、套餐与权益、订阅、额度、支付与退款、邮件、日志与 AI 配置；CNIPA 与 Zucker Copyright 迁移到同一套实现并删除各自副本。产品只保留核心业务、自己的套餐内容/价格/功能清单、文案与业务页面。

本文遵循[能力归属](architecture.md#新增能力的归属与接入)：机制进 Framework，策略留给产品。

## 1. 现状

| 能力 | Framework 现有 | CNIPA | Copyright |
| --- | --- | --- | --- |
| 登录、会话、刷新 | `auth` 持久会话；server 模板 `/authorize/*` + Cookie 刷新；`fe-auth` 会话绑定（1.0.17） | 本地 `/auth`，Cookie 刷新 | 本地 `/auth`，请求体刷新 |
| 用户/角色/权限/菜单 | `admin` 的 users/roles/permissions/menu 特性与模板页面 | 本地控制器与页面 | 本地控制器与页面（前端静态菜单） |
| 套餐（权益 + 额度） | 无。模板套餐是 `BILLING_CATALOG_JSON` 静态配置 | 本地 `subscription_plans`（features/quotas JSON）+ 页面 | 同结构 + 功能目录、按功能额度、草稿 |
| 用户订阅 | 模板只读 `/management/subscriptions` | 本地 CRUD | 本地 CRUD + 指定/修改 |
| 额度用量/预留 | `credit` 的 `QuotaCapacity`、`QuotaReservationService`；模板 `quota_usage`/`quota_reservations` | 本地表 + Framework 只读控制器 | 本地表 + 本地只读控制器 |
| 支付、订阅计费、退款 | `payment` 适配器与服务；模板 orders/subscriptions/refunds 控制器与页面 | 本地订单、优惠券、发票、退款 | 本地 Stripe 订阅计费、退款、对账 |
| 积分 | `credit` 账本；模板积分页 | 本地积分包与流水 | 无 |
| 邮件模板/发送记录 | `createMailTemplateAdminController`；`MailHistoryService`；无页面、无 schema | 已接入模板控制器 + 本地页面 | 无 |
| 日志、AI 模型、Prompt 目录 | `admin` 控制器工厂 | 已接入 | 本地实现 |
| 后台前端 | `templates/admin`（复制式脚手架） | 自建（Radix/Tailwind） | 自建（antd Pro） |

结论：机制大多已在 Framework，缺的是 **套餐/权益/订阅的管理机制**、**可升级的后台页面分发方式**，以及模板与两个产品之间的 **一致契约**。

## 2. 范围

纳入：
- 认证与会话（统一到 server 模板的账户模块）；用户、角色、权限、菜单。
- 套餐目录（数据库持久化、后台编辑、草稿/上下架）、权益判定、按计数器的额度（月度/每日/终身）、额度预留与结算、按资源一次计费（例如“每个项目计 1 次”）。
- 用户订阅：后台指定/修改/取消，支付回写，有效期判定。
- 支付订单、订阅计费周期、退款（复用 `payment` 与模板 billing），积分（复用 `credit`）。
- 邮件模板与发送记录；访问/操作日志；AI 模型与 Prompt 目录；健康检查。

不纳入（留在产品）：具体套餐与价格、功能清单的业务含义、业务任务、Prompt 内容、邮件受众与文案、产品专属页面（原型、文档任务、专利等）。

## 3. 包划分

| 包 | 新增/扩展 | 内容 |
| --- | --- | --- |
| `@zucker-framework/credit` | 扩展 | `EntitlementService`：给定订阅快照与功能目录，判定功能开关与计数器限额；计数器周期（`month`/`day`/`lifetime`，时区可配）；“按资源一次计费”（resourceKey 去重，成功确认、失败释放）。沿用现有 `QuotaCapacity` 与 `QuotaReservationService` 的原子语义。 |
| `@zucker-framework/payment` | 扩展 | 套餐目录端口 `PlanCatalogStore`（列表、按 slug、多价格 `prices[]`、修订号 CAS）与套餐商品解析（`resolveOffer` → 冻结快照）；订阅指派服务（后台指派、支付回写与支付台账、取消、有效期判定）。价格/币种/渠道引用仍是产品数据。 |
| `@zucker-framework/admin` | 扩展 | 控制器工厂：`createPlanAdminController`、`createUserSubscriptionAdminController`、`createQuotaAdminControllers`（用量/预留，带字段投影）、`createMailLogAdminController`；补 `createReadOnlyAdminController` 的字段投影选项；端口错误按 `PortErrorReason` 映射（见 8.8）。 |
| `@zucker-framework/fe-types` | 扩展 | `fe-types/back-office` 子入口：第 8 节的请求/响应类型与唯一的 `PortErrorReason`，由 `admin`、`payment`、`credit`（类型与错误标记）和 `fe-admin` 共用。 |
| `@zucker-framework/fe-admin`（新） | 新建 | Radix + Tailwind 后台页面组件与布局：登录、用户、角色、权限、菜单、套餐、订阅、额度、订单、退款、积分、邮件模板/记录、日志、AI 模型、Prompt、健康检查；通过配置注入路由前缀、权限编码、功能目录、额度标签与文案。模板与产品以 npm 版本消费，升级只需改版本。 |
| `templates/server`、`templates/admin` | 扩展 | 组合以上能力，作为新项目默认后台；Prisma schema 与迁移随模板提供。 |
| `@zucker-framework/cli` | 扩展 | `zucker create` 生成的后台默认启用上述页面，可按特性关闭。 |

新建 `fe-admin` 的理由：两个现有产品与模板都需要同一组页面，复制式模板无法升级；已有 `fe-*` 包只提供底层（认证、HTTP、权限、表单），不提供页面。

## 4. 数据模型

以模板 schema 为基线，新增（表名均可由产品映射）：

- `subscription_plans`：`id, slug(unique), name, description, status, order, features(Json), quotas(Json), revision, createdAt, updatedAt`。
- `subscription_plan_prices`：`id, planId, interval(month|year|one_time|lifetime), currency, amount(精确十进制文本), termDays(仅 one_time)`，`UNIQUE(planId, interval, currency)`；`subscription_plan_price_refs`：`priceId, provider, reference`，`UNIQUE(provider, reference)`（一个渠道引用只售卖一个价格）。两个产品现有的 `price/yearlyPrice/currency/stripe*PriceId` 列迁移为价格行。
- `user_subscriptions`：`id, userId(unique), planId, status, billingCycle(MONTHLY|YEARLY|ONE_TIME|LIFETIME), startDate, endDate, cancelAtPeriodEnd, source(admin|payment), paymentReference, …`；`user_subscription_payments`：每个支付证据一行（`reference` 唯一），用于幂等、审计与退款挂接。
- 额度：沿用模板 `quota_usage`、`quota_reservations`（字段与两个产品的 `user_quota_usages`、`quota_reservations` 对齐，增加 `resourceType/resourceId` 与 `activeResourceKey` 用于按资源、按计数器计费）。
- `billing_orders.configRevision`：下单时生效的支付连接配置修订号（可空，热生效用）。
- 邮件：`email_templates`、`email_logs`（补齐现有服务默认模型缺失的 schema）。

功能目录（feature catalog）与额度键不进数据库，由产品在代码中声明并注入服务端与 `fe-admin`（Copyright 的 `SUBSCRIPTION_FEATURES`/`SUBSCRIPTION_QUOTAS` 是现成样例）。

## 5. 迁移

1. Framework 实现并发布（含模板与 `fe-admin`）。
2. Copyright：服务端改用 Framework 控制器与服务；admin 改为 `fe-admin` 页面 + 产品业务页；认证切到账户模块；数据库按映射保留现有表，必要的列补齐走经授权的增量迁移；旧实现删除。产品库需要的增量（与模板 `20261109000000_back_office` 同义，约束名按产品表实际名称）：
   - 套餐价格：建 `subscription_plan_prices`/`subscription_plan_price_refs`，把每个套餐的 `price`(+`currency`, `stripeMonthlyPriceId`) 写成 `month` 价格、`yearlyPrice`(+`stripeYearlyPriceId`) 写成 `year` 价格，再删除旧列；加 `revision`。
   - `quota_reservations`：加可空 `activeResourceKey` 并按 `sha256(各字段 UTF-8 字节长度:值 依次拼接)` 回填 RESERVED/CONFIRMED 行，建唯一索引与 `(activeResourceKey IS NOT NULL) = (status IN ('RESERVED','CONFIRMED'))` CHECK；删除旧的 `(subjectId,counter,resourceType,resourceId)` 唯一约束。`limit` CHECK 放宽到 `>= -1` 时使用产品库里该约束的真实名称。
   - `user_subscription_payments`、`billing_orders.configRevision`、`user_subscriptions.billingCycle` 增加 `ONE_TIME`。
   - 权限与菜单数据：管理员创建命令只在首次安装时写入权限行与启动菜单，已安装的库不会再执行它。模板迁移末尾的幂等数据步骤（`ON CONFLICT DO NOTHING`）为升级库补齐 `BACK_OFFICE_PERMISSIONS` 权限行，并只在对应启动分组（`starter:commerce`/`starter:operations`）仍存在时补齐新增启动菜单（套餐、用户订阅、额度用量/预留、邮件模板/记录），未改名的 `starter:subscriptions` 更名为“支付订阅”；管理员删除的分组不会被重建，已改名的菜单保持不变。产品库按自己的菜单 id 与权限码执行同义步骤。
3. CNIPA：同上；其优惠券、发票、积分包若不在第一版范围，暂留产品并记录为后续提取项。
4. 每个产品的生产切换单独授权：备份、副本演练、增量 SQL、可回滚的镜像切换。

## 6. 已确认的决定（2026-11-09，维护者）

1. **套餐来源**：数据库 + 后台编辑；模板的 `BILLING_CATALOG_JSON` 仅作初始化种子。
2. **后台页面分发**：新建 `@zucker-framework/fe-admin`，模板与产品都以 npm 版本依赖。
3. **认证契约**：统一为 server 模板账户模块（`/authorize/*`、HttpOnly Cookie 刷新、后端菜单）；Copyright 迁移其登录与刷新流程。
4. **UI 技术栈**：`fe-admin` 基于 Radix + Tailwind（以 CNIPA `apps/admin/src/components/admin/` 的表格/表单/对话框为起点）；模板现有 antd 页面与 Copyright 后台迁移到该栈。

## 7. 实施顺序

1. `credit`：EntitlementService、计数器周期、按资源计费（含 PostgreSQL 契约测试）。
2. `payment`：PlanCatalogStore、订阅指派服务。
3. `admin`：套餐、订阅、额度、邮件记录控制器工厂与字段投影。
4. `fe-admin`：布局与全部页面，配置化。
5. 模板接入、schema/迁移、`zucker create` 默认启用；端到端浏览器验收。
6. 发布；Copyright 接入；CNIPA 接入。

## 8. 接口契约（服务端与 `fe-admin` 共同遵守）

所有路径位于 server 全局前缀 `/api` 下；响应沿用模板的统一包装。权限编码为 `<资源>:<动作>`，管理员角色 `superadmin` / `*` 拥有全部权限。

### 8.1 权益目录与当前用户
- `GET /billing/entitlements/catalog`（公开）→ `{ features: [{key,label,description,category:'metered'|'benefit',counter?}], counters: [{key,label,unit,period:'month'|'day'|'lifetime'}] }`。目录由产品在服务端代码中声明。
- `GET /billing/entitlements/me`（登录）→ `{ active, plan:{id,slug,name}|null, status, validUntil, features:{[key]:boolean}, quotas:{[counter]:{limit,used,reserved,remaining,period}} }`；`-1` 表示不限。

### 8.2 套餐
套餐是在售价格的唯一来源：每个价格是 `{interval: month|year|one_time|lifetime, currency, amount(十进制字符串), termDays(仅 one_time), providerRefs:{渠道id: 渠道商品引用}}`，同一套餐内 `(interval, currency)` 唯一，一个渠道引用全局只售卖一个价格。`BILLING_CATALOG_JSON` 的订阅商品只作为初始化种子。
- `GET /billing/plans[?currency=USD]`（公开）→ 已上架套餐（含 features/quotas 与价格列表；每个价格带 `purchasable`、`offerId`、可售渠道 `providers`，不含渠道引用）。
- `GET /management/plans`（`plans:query`）→ 全部套餐；`GET /management/plans/:id`。
- `POST /management/plans`（`plans:add`），`PUT /management/plans/:id`（`plans:update`，可带 `expectedRevision`），`PATCH /management/plans/:id/status` `{status:boolean}`（`plans:update`），`DELETE /management/plans/:id`（`plans:delete`，仅无订阅、支付记录、未结订单或在用渠道订阅引用时）。
- 写入校验：features 值为布尔且键在目录内；quotas 值为 `-1` 或非负整数且键在目录内；slug 唯一；金额只接受字符串且精度不超过币种；`stripe` 引用为 Price ID 格式；`prices` 整体替换。
- 结账：`POST /billing/orders {offerId, providerId}` 的 `offerId` 为 `plan:<planId>:<interval>:<currency>` 时，价格、币种与渠道引用取自下单时的套餐，并把快照 `{planId, slug, revision, interval, currency, amount, termDays, providerId, providerRef}` 冻结在订单 `offer.fulfillmentData.plan`。月/年为渠道订阅（需渠道可证明计费周期），一次性/终身为单次支付。套餐订单不发放积分；支付回写只使用冻结快照的 `planId`（不按 slug 或渠道引用反查）。

### 8.3 用户订阅
- `GET /management/subscriptions`（`subscriptions:query`）分页，过滤 `userId,status,planSlug,active(active|inactive)`；返回用户摘要（id、用户名、邮箱）与套餐摘要。
- `GET /management/subscriptions/:userId`（`subscriptions:query`）→ 订阅 + 额度快照（同 8.1 `quotas`）。
- `PUT /management/subscriptions/:userId`（`subscriptions:update`）`{planSlug,billingCycle:'MONTHLY'|'YEARLY'|'ONE_TIME'|'LIFETIME',status,startDate?,endDate?}`：后台指派、修改或撤销（`status: EXPIRED`）；省略日期则沿用当前有效期；套餐支付未结清或渠道订阅仍在计费时拒绝。
- `DELETE /management/subscriptions/:userId`（`subscriptions:update`）：取消（保留到期日）；终身订阅没有到期日，不能取消，只能撤销。

### 8.4 额度
- `GET /management/quota-usage`（`quota:query`）过滤 `userId,counter,period`。
- `GET /management/quota-reservations`（`quota:query`）过滤 `userId,counter,status,resourceType`；返回字段投影，不含内部元数据。
- `POST /management/quota-reservations/:id/release`、`/confirm`（`quota:update`）。

### 8.5 邮件、日志、AI
- `/management/email-templates`：`createMailTemplateAdminController`（`mail:query` / `mail:update`）。
- `GET /management/email-logs`（`mail:query`）分页，过滤 `to,status,template`。
- 访问/操作日志沿用 `/management/access-logs`、`/management/operation-logs`（`logging:query`）。
- `/management/ai-models`：`createAIModelAdminController`（`ai-models:query|read-secret|add|update|delete`）。

### 8.6 认证、菜单
沿用 server 模板：`/authorize/login|refresh|logout|me|profile|password|sessions`，`GET /menu/tree`。`fe-admin` 只依赖这些接口与 8.1–8.5。

### 8.7 服务端落地说明（2026-11-09，含对上文的最小调整；评审修正后更新）

类型：以下形状均以 `@zucker-framework/fe-types/back-office` 的类型为准（`SubscriptionPlan`、`PublicPlan`、`UserSubscriptionRow/Detail`、`QuotaUsageRow`、`QuotaReservationRow`、`MailLogRow`、`EntitlementCatalogResponse`、`PortErrorReason` 等），`admin` 的端口与 `fe-admin` 页面共用这些类型。

响应形状（模板使用 `@zucker-framework/common` 的错误包装 `{status, code, message, result}`，成功响应为响应体本身）：
- `GET /billing/plans` 每项：`{id,slug,name,description,order,features,quotas,prices:[{interval,currency,amount,termDays,purchasable,offerId,providers}]}`；金额按币种格式化（如 `"19.90"`），不返回渠道引用。`purchasable` 表示金额大于 0 且至少一个已启用渠道能售卖该价格；`offerId` 即下单用的商品 id。
- `/management/plans` 返回完整套餐记录（含 `status`、`prices`（含 `providerRefs`）、`revision`、`createdAt/updatedAt`）。写入失败 400（`result.issues: string[]`）；slug 或渠道引用冲突、`expectedRevision` 过期均为 409；删除被引用套餐 409；`DELETE` 成功返回 `{deleted:true}`。
- `GET /management/subscriptions` → `{data,total,page,pageSize}`，每行 `{id,userId,status,billingCycle,startDate,endDate,cancelAtPeriodEnd,canceledAt,source:'admin'|'payment',active,createdAt,updatedAt,user:{id,username,email},plan:{id,slug,name}}`。`GET/PUT/DELETE /management/subscriptions/:userId` 返回同一行（扁平）再加 `features` 与 `quotas`（同 8.1）；无订阅时 `GET` 为 404。`status` 取值 `ACTIVE|CANCELED|EXPIRED`：到期不做定时清扫，过期判定由 `active` 给出，按有效性筛选用 `active=active|inactive`；`EXPIRED` 只由撤销写入。
- 24 小时内创建的未结清套餐订单（`pending`/`requires_capture`/`unknown`；托管收银台会话最长 24 小时有效，更早的订单留给对账）以及仍在计费的套餐渠道订阅（`active`/`trialing`，未过期的 `past_due`，24 小时内的 `unknown`）使修改期限的 `PUT` 返回 409，`result.details.blocking = {kind:'order'|'subscription', id, state}`；仅含积分的订单与订阅不阻止。撤销（`PUT` 且 `status: EXPIRED`）与取消（`DELETE`）只被渠道订阅阻止，不等待未结清的订单：撤销之后才付款的、在撤销之前创建的订单（及其订阅的各期回执）只记账、结果为 `revoked`，不会复活期限，并写入 `billing.plan-payment-unapplied` outbox 事件供退款；取消之后付款的订单照常按下述规则生效（取消只停止续期，用户已付款的期限予以兑现）。
- 下单准入（订单创建之前，`SubscriptionAssignmentService.admitPurchase`，与回写同一套优先级）：付款后不会改善期限的套餐购买返回 409，`result.details.refusal` 为 `lifetime_active`（有效的终身期限）、`longer_admin_term`（管理员授予的另一套餐期限晚于本次购买的结束时间）、`term_covers_purchase`（同一套餐的现有期限已覆盖周期订阅的第一期；可等到期后续订或购买一次性期限），或 `provider_subscription`（409 `pending_payment`，仍在计费的渠道套餐订阅，需先取消）。未结清的其他订单不阻止下单。
- 渠道价格校验：下单前，渠道适配器若提供 `quote`（Stripe 客户端带 `prices` 时读取 Price；PayPal 订阅读取计划价格；PayPal 一次性订单直接使用快照金额），其价格的金额/币种/模式与套餐快照不一致时返回 409（`conflict`），不创建订单也不产生可付款链接。没有价格查询的渠道仍在创建会话后、发出链接前比对渠道返回的应付金额，付款后再核对实付金额。后台改价后须同步修改渠道价格（或换用新的渠道引用）。
- 支付回写（月/年周期回执、一次性/终身订单）按冻结快照写入；每个支付引用在 `user_subscription_payments` 只记一次（记录实际支付的期间）。规则：已结束的周期只记账不改期限；有效的终身期限不被支付覆盖；同一套餐的一次性期限叠加到现有期限之后（从 max(当前时间, 现有结束时间) 起算已付天数），周期回执只延长不缩短，终身购买使期限变为终身；另一套餐的支付替换当前期限，除非管理员授予的期限结束更晚，或当前期限由开始更晚的支付证据决定（乱序的旧回执只记账）。下单准入与回写使用同一规则，因此下单时已被拒绝的情形不会产生付款；若期限在下单与付款之间改变，结果为 `kept`/`superseded`/`revoked` 的下单付款（周期续费为 `kept`/`revoked`）写入 `billing.plan-payment-unapplied` outbox 事件（含金额与支付引用）供退款。变化通过同事务的 `billing.plan-term-changed` outbox 事件发布；后台指派/取消在提交后发出进程内事件 `subscriptions.changed`。
- 套餐履约钩子以 `plans: true` 注册；没有注册该钩子时，带套餐快照的订单与订阅回执的履约事务失败（订单保持可重试），不会在无权益的情况下完成履约。种子套餐（`BILLING_CATALOG_JSON`）与后台写入一样经过 `validatePlanWrite` 校验与规范化，无效的种子记录警告后跳过，不会中断管理员创建。
- 额度列表为字段投影：用量 `{userId,counter,period,limit,used,updatedAt}`，预留 `{id,userId,counter,period,amount,limit,status,resourceType,resourceId,expiresAt,createdAt,finishedAt,reason}`（不含 policyVersion 与内部键）；均为 `{data,total,page,pageSize}`，另有 `GET /management/quota-reservations/:id`。`release` 可带 `{reason?}`；两动作返回 `{id,changed}`（`changed:false` 表示已处于终态），已终止的预留 `confirm` 返回 409。
- 按资源计费：同一资源在每个计数器上各计一次；另一个请求仍持有该资源的有效预留时返回 409（`in_progress`），而不是免费放行；过期未清扫的预留在下一次计费时于同一锁内转为 `EXPIRED`；工作成功后确认失败时返回工作结果并记录日志（该次不计费）。
- `GET /management/email-logs` → `{data,total,page,pageSize,totalPages}`，行 `{id,userId,recipient,subject,template,provider,messageId,status,errorMessage,createdAt}`，不含 metadata；`status` 为 `success|failed`，`to` 至少 3 个字符才参与过滤。

调整：
1. 路由冲突（破坏性变更）：模板原有的支付渠道订阅只读列表 `GET /management/subscriptions`（`billing:query`）改为 `GET /management/billing-subscriptions`，`/management/subscriptions` 按 8.3 用于用户套餐订阅。`fe-admin` 默认使用新路径；仍在旧模板路由上的产品需设置 `endpoints.billingSubscriptions`。
2. 依赖边界：`admin` 不依赖 `payment`，套餐与订阅控制器以结构化端口（`PlanAdminPort`、`UserSubscriptionAdminPort`、`QuotaReservationAdminPort`）注入；`payment` 不依赖 `credit`，有效期判定以 `activeTerm` 注入（传 `isActiveTerm`）。三者只共同依赖浏览器安全的 `fe-types/back-office`。
3. AI 模型：server 模板通过运行时连接配置管理 AI，没有 `aiModels` 表与 `AIModelCatalogService`，因此 `/management/ai-models` 未在模板接入；需要模型目录的产品自行提供该服务后用 `createAIModelAdminController` 注册（`fe-admin` 的 `ai.providers` 默认为空，需显式配置）。
4. 数据模型：见第 4 节。资源唯一性由可空 `activeResourceKey @unique` 表达（Prisma 可表示），不再使用部分唯一索引；模板 e2e 的 `schema-drift` 用例对后台表执行 `prisma migrate diff` 守护。`email_templates/email_logs` 使用 `TIMESTAMPTZ`。`email_templates` 的内容列为 `htmlContentEn`（必填）/`htmlContentZh`，产品可通过 `contentFields` 映射自己的列。
5. 启动菜单路径（供 `fe-admin` 对齐）：`/plans`、`/user-subscriptions`、`/quota/usage`、`/quota/reservations`、`/mail/templates`、`/mail/logs`；原支付订阅菜单更名为“支付订阅”。创建管理员时同时写入 8 节的权限行（`plans:*`、`subscriptions:*`、`quota:*`、`mail:*`）与各启动菜单的权限行，便于授权给非超级管理员角色；已安装的库由迁移末尾的幂等数据步骤补齐（见第 5 节）。`fe-admin` 只把路径匹配最长的菜单项标为当前项（`aria-current`），面包屑沿同一项展开。
6. 会话恢复与限流：Cookie 刷新的机制在 `@zucker-framework/fe-http-client`（`createKeepaliveCookieRefresh` + `createRefreshExchange`：`fetch` keepalive、按页面标记的在途交换、对其他页面中断的交换在 10 秒内退避重试 401、单次超时）与 `@zucker-framework/fe-auth`（`createCookieSession`：每页一次恢复、身份变化保护、跨标签页 `storage` 同步、`navigator.locks` 串行）；`fe-admin` 只做组合。服务端轮换与重放拒绝不变。模板把 `/authorize/refresh` 与 `/authorize/me` 移出凭据预算（`session-refresh` 按当前有效刷新令牌的会话、`session-refresh-network` 按 IP、`session-read` 按用户），登录/注册/验证/重置密码仍为每 IP 每分钟 20 次（`src/rate-limits.ts`）；反向代理后必须设置 `TRUST_PROXY`（跳数或代理地址，拒绝 `true`）。服务端显示文本附带稳定的 `labelKey`（连接名称、分类、字段、说明、权益目录），`fe-admin` 先按键、再按原文翻译，模板提供 en-US 表。
7. 热生效：SMTP 由共享的 `SmtpTransport`（连接配置 `account-email`，账户邮件与 `MailService` 共用）按需解析；`SUBSCRIPTION_OPTIONS` 为解析函数；`BILLING_OPTIONS` 可为值或解析函数（静态商品与订单的 `configRevision` 随之变化；渠道 SDK 实例的热替换属于 Phase 1.1）。订单记录 `configRevision`（`payment-*` 连接配置的已应用修订）。
8. 退款：套餐订单不发放积分，模板的积分回收式退款流程拒绝其退款（请在渠道后台退款并在订阅管理中调整期限）；退款不会自动收回套餐期限，支付台账 `user_subscription_payments` 是将来自动收回的挂接点。

### 8.8 错误协议

领域端口（`PlanCatalogError`、`SubscriptionAssignmentError`、`QuotaReservationError`、`ResourceChargeError`）以 `fe-types/back-office` 的 `PORT_ERROR` 标记，`reason` 属于唯一的 `PortErrorReason`：`invalid`→400，`not_found`→404，`conflict|referenced|pending_payment|inactive|in_progress`→409，`unavailable`→503。`admin` 只翻译带标记的错误（其他带 `reason` 字段的第三方错误原样抛出），响应体为 `{statusCode,message,code:reason,reason,issues?,details?}`；经 `HttpExceptionFilter` 包装后为 `{status,code:reason,message,result:{reason,issues?,details?}}`。客户端用 `readPortError(body)` 读取两种形状。
