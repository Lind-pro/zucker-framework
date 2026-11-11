# 既有产品接入后台宿主（`@zucker-framework/back-office`）

适用版本：`@zucker-framework/*` 1.0.21 起（fixed group）。本文说明一个已有数据库、已有用户和已有会话的产品，如何改为组合 `@zucker-framework/back-office` 的服务端宿主而不迁移或丢失数据。宿主的选项、路由与令牌见 [back-office README](../packages/back-office/README.md)，接口契约见 [back-office RFC](back-office-rfc.md) §8。

本文给出机制与顺序，不授权任何生产动作：结构迁移、数据回填、凭据轮换与切换各自需要产品维护者对确切目标的授权，并先在副本上演练。

## 1. 原则

- **按版本组合，不复制源码。** 产品依赖已发布的固定版本；不要把模板或宿主源码复制进产品，也不要用相邻仓库源码或 `file:`/`link:` 依赖代替正式制品。
- **机制在宿主，策略留在产品。** 套餐内容、价格、功能目录、文案、权限码、菜单、邮件措辞、登录方式的取舍都是产品配置；宿主只接收选项与端口。
- **保留数据。** 现有表名、列名与枚举通过 `models`/`tables`/`fields` 映射；只做 expand（新增可空列、新表、回填），破坏性的 contract 步骤单独、延后执行（第 3 节）。
- **一次切换一个面。** 账户、订阅/额度、计费、管理/邮件、设置可以分阶段接入；每阶段服务端、后台前端与站点前端一起切换，旧实现随即删除，不保留并行的第二套实现。

## 2. 组合前提

1. 根模块配置一次全局能力：`DATABASE_ADAPTER`（`@zucker-framework/crud`）、`ZuckerAuthModule`（JWT、权限、`AuthenticationHolder`）、`ZuckerRateLimiterModule`（包含宿主路由使用的 `api-default` 限流器）、日志、配置、通知。宿主只注入，不重复注册。
2. 需要锁或原始 SQL 的宿主（accounts 的行锁/咨询锁与删除、subscriptions 的锁、billing、settings）要求事务适配器提供 `query(sql, values) → { rows }`（PostgreSQL）。Prisma 产品可参照模板 `templates/server/src/database.ts`：`PrismaAdapter` 子类的 `$transaction` 交出一个同时提供 `model()` 与 `$queryRawUnsafe` 的事务包装。宿主只拼接经校验并加引号的标识符，值一律参数化。
3. 根模块注册 `AccountGuard`（`/accounts` 导出）与 `PermissionsGuard` 为 `APP_GUARD`，并使用 `@zucker-framework/common` 的 `TransformInterceptor`。普通控制器返回业务值；`@RawResponse()`、`@Sse()`、`StreamableFile` 与声明了非 JSON `Content-Type` 的路由（如 Prometheus `/metrics`）不被包装。
4. 后台前端改用 `@zucker-framework/fe-admin` 的同版本；站点前端的会话改用 `@zucker-framework/fe-auth` 的 Cookie 会话。

## 3. 数据库：别名、字段映射与 expand/contract

### 3.1 模型与表名别名

宿主通过 `DatabaseAdapter.model(name)` 访问模型，原始 SQL 使用 `tables`。两种映射方式可以并用：

- 宿主选项：`models: { users: 'user', subscriptions: 'userSubscription', … }`、`tables: { … }`（未知键与非标识符在启动时被拒绝）。
- 适配器别名：`new PrismaAdapter(client, { modelAliases: { users: 'user' } })`。`@zucker-framework/auth` 的 `UserService` 固定读取 `users`，所以用户模型至少要有这一个别名。

可选的关联表（accounts 的 `userPermissions`、`userSettings` 等）不存在时设为 `null`，相关步骤被跳过。

### 3.2 字段映射与取值

- `/subscriptions` 的 `fields` 按模型把逻辑字段映射到产品字段，例如 `quotaUsage: { subjectId: 'userId', counter: 'quotaType' }`、`quotaReservations` 同理。
- 状态与周期取值保持 Framework 的取值（`ACTIVE`、`RESERVED`、`MONTHLY` 等），可以是文本列或 PostgreSQL 枚举列；**不支持取值改名**（后台枚举过滤依赖这些值）。取值不同的产品在 expand 阶段回填为 Framework 取值。
- 套餐表中仍为 `NOT NULL` 的旧列（如 `price`）在新写入时由 `planRowExtras(write, mode)` 补值，这样旧版本镜像仍能读取，回滚安全；不要为了接入删除旧列。
- `/accounts` 的会话模型需要 `credentialVersion, authMethod, oauthBindingId, refreshJti, revokedAt, revokedReason, expiresAt, lastActiveAt, createdAt`；缺失的列在 expand 迁移中以可空列加入。
- `/mail` 的投递记录使用 MailService 的历史字段（`recipient, subject, template, provider, messageId, status, errorMessage, metadata`）；`templates.contentFields` 映射模板内容列。

### 3.3 expand / contract 顺序

1. **expand（随新版本一起上线，可回滚）**：新增表与可空列、宽松化 CHECK、回填（例如套餐价格行、`activeResourceKey`、订单 `fulfillmentData` 的套餐快照、`cancelState` 取值映射），再建唯一索引。迁移只前进；已应用的迁移不修改。
2. **切换**：新镜像读写新结构；旧镜像仍可读（旧列保留、旧取值不再写入前已完成回填）。
3. **观察期**之后，**contract（单独授权）**：删除旧列、旧约束与被取代的表。contract 迁移单独成文件，不与 expand 合并，生产执行前再次备份。

模板迁移（`templates/server/prisma/migrations`）是各结构的参照；产品按自己的表名与约束实际名称写同义步骤，`prisma migrate diff`（模板的 `schema-drift` 用例）可用于核对结构是否一致。

## 4. 已签发的会话与令牌

- **访问令牌**：`tokens.additionalAccessVerifiers` 接收产品的旧令牌验证器（类或实例）。主验证失败后依次尝试；返回的 `{ userId, sessionId }` 仍要通过会话检查（会话存在、未撤销、未过期、`credentialVersion` 一致、登录方式允许），因此旧令牌不能绕过撤销。
- **刷新令牌重用**：1.0.21 起，已轮换的刷新令牌再次出现时撤销该会话（宽限期 10 秒内只拒绝，用于客户端重试丢失的响应）；产品切换前确认客户端不会在宽限期之外重放旧 Cookie。
- **刷新**：旧刷新 Cookie 名或路径通过 `cookie: { name, path, secure, domain }` 保持（如 host-only Cookie 不设 `domain`）。需要无感升级时保留一段明确期限的旧刷新路径（例如 30 天），到期后删除验证器与旧路径。
- **声明**：`tokens.extraClaims(user)` 可以返回空对象，以保持旧令牌的声明集合；不能设置 `sub, sid, tokenUse, aud, exp, iat, nbf, jti, iss`。
- **密码**：`passwordEncoder` 用于注册、登录、改密、重置与假哈希（防止枚举用户的计时差异）；scrypt 存储使用 `ScryptEncoder`。
- **验证码登录与验证**：`verification: { mode: 'code', attempts, fields: { subject, purpose } }` 使用六位码；产品自有的登录方式通过 `signInMethods` 声明并调用 `AccountService.signIn(user, method)`，与内置路由返回同样的 Cookie/响应体或二次验证挑战。

## 5. 环境固定的连接配置

`/settings` 的 `connections.environmentPins` 把某些连接字段固定为部署环境的值（`{ 'payment-stripe': true, 'webdav-storage': ['WEBDAV_BASE_URL'] }`）：

- 被固定的字段在接口中标记 `pinnedByEnvironment: true, readOnly: true`，`fe-admin` 只读显示；保存时修改它返回 400，`keep` 允许；数据库中不写入其值，旧的已存值在下次保存时被丢弃。
- 全部字段被固定的配置项返回 `canSave: false, saveUnavailableReason: 'environment_pinned'`。
- 存储位置类配置（WebDAV 端点/基路径）配合 `createDataLocationGuard` 使用：已有数据时更改位置需要显式确认（409 `DATA_LOCATION_CHANGE_UNACKNOWLEDGED`）。WebDAV 配置项来自 `@zucker-framework/storage` 的 `WEBDAV_STORAGE_CONNECTION_DESCRIPTOR`，校验用 `webDavOptionsFromConnection`。

产品在接入初期把已有的环境变量全部固定，确认后台写入路径后再逐项解除固定。

## 6. 只售套餐的计费（plans-only）

没有积分账本的产品使用 `BackOfficeBillingModule.forRoot({ credits: null, … })`：

- 不读任何积分表；订单只售卖套餐，履约由 `/subscriptions` 的套餐回写完成（`billing: BILLING_SERVICE` 登记 `createPlanFulfillmentHooks`）。
- 套餐订单按实付金额退款；某笔付款被全额退款时，订阅宿主收回或缩短由该付款确定的期限（`SubscriptionAssignmentService.revokePayment`），部分退款保留期限。
- 客户申请/审批放在 `ports.refunds` 的 `admit`（派发前，例如要求存在已批准的退款申请）与 `settled`（终态后同步产品记录）；渠道价格核对放在 `ports.checkout.verifyOffer`，丢失响应的订单恢复核对放在 `verifyRecovery`。
- 只售套餐模式必须显式提供 `lockAccount`（默认锁依赖积分账本的 `credit_account_locks` 表，启动时拒绝缺省），且必须与产品其他按账户计费的路径（包括 `/subscriptions` 的 `locks.account`）使用同一把锁。
- 既有订单在 expand 阶段回填 `fulfillmentData`（`{ credits: 0, expiresInDays: null, grantBasis: 'period', plan: { … } }`）；退款表按模板建立，但不建立指向积分冻结表的外键，`totalCredits` 允许为 0。

## 7. 菜单、权限与管理员

- `syncPermissions(db, codes)` 与 `syncMenus(db, catalog, { idPrefix })` 只写出差异，可以在每次部署时运行；`createAdministrator` 只用于首次安装。
- 产品旧权限码在 expand 阶段映射到 Framework 权限码（角色授权一并迁移）；不要在宿主中保留旧码的并行检查。
- 后台的用户类型、套餐预设、管理员重置密码与登录页“忘记密码”链接分别由 `fe-admin` 的 `users.typeOptions`、`plans.presets`、`users.passwordReset`、`login.forgotPasswordHref` 配置。

## 8. 验收清单

- 宿主选项在启动时校验通过（错误为 `TypeError('[back-office/<host>] …')`）。
- 关闭的功能不注册路由、不读相关表（产品的 e2e 覆盖到关闭的功能应得到 404）。
- 用产品的真实结构（副本库）跑 PostgreSQL 契约测试：别名、字段映射、枚举列、锁与并发计费、退款一次性撤销期限。
- 旧会话在切换后仍可刷新，撤销后立即失效；旧令牌验证器在到期日删除。
- 环境固定字段在后台只读、保存不落库。
- 生产切换按产品的部署清单单独授权：备份、副本演练、expand 迁移、镜像切换、观察期、contract 迁移。
