# 新 SaaS 从初始化到首条业务

适用：1.0.10 的完整 Server、Admin、Web 模板。**1.0.10 整批已发布到 npm，并完成52包版本、校验和与latest核对**，可以使用下列固定版本命令。后续候选验证仍须使用明确的固定 tarball 和依赖闭包。正式安装与接入边界见[初始化指南](getting-started.md)。

本手册按首次使用顺序组织。每个新产品拥有自己的目录、数据库、品牌、商品和业务处理器，通用能力通过公开包复用。

## 0. 推荐：一条命令生成完整工作区（1.0.20 起）

1.0.20 发布后（在此之前只能用本地 CLI 产物验证），可以直接生成包含 Server、Web、Admin 的 pnpm 工作区：

```sh
pnpm create @zucker-framework/app my-saas            # 等同于下一行
pnpm dlx @zucker-framework/cli@1.0.20 create my-saas [--locale en|zh] [--no-admin] [--no-web]
cd my-saas && pnpm install
docker compose up -d --build                         # PostgreSQL、Redis、MinIO、Mailpit、一次性迁移、三个应用
# 或者：pnpm dev:infra && pnpm db:migrate && pnpm dev  # 只在 Docker 中运行数据库与邮件，应用跑在本机
```

生成结果是 `apps/{server,web,admin}`、`docker-compose.yml`、各应用 Dockerfile 和**一个**根目录 `.env`（`0600`，JWT、配置加密、缓存刷新、数据库、Redis、对象存储密钥均随机生成且不打印）。`--locale` 决定 Web/Admin 的默认语言，默认 `en`，两种语言始终都带。迁移由 compose 中的 `migrate` 服务显式执行一次，不在 Server 启动时运行。

在 `.env` 中填写 `BOOTSTRAP_ADMIN_USERNAME/EMAIL/PASSWORD` 后执行 `pnpm setup:admin`：创建第一个管理员，并且只做一次地写入起始数据——`BILLING_CATALOG_JSON` 中的订阅商品成为套餐、一次性商品成为积分包，`apps/server/content/` 下的首页（区块文档）、隐私/条款/退款页、更新日志、示例博客与文档发布进 CMS。之后这些内容都在 Admin 中编辑；管理员删除的积分包不会被再次写入。完成后从 `.env` 删除引导密码。

本地注册邮件由 Mailpit 接收（`http://localhost:8025`，不需要 SMTP 认证）。需要无邮件注册时，在 Admin「系统设置 → 产品策略」中关闭 `requireEmailVerification`，或用 `POLICY_ACCOUNT_REQUIRE_EMAIL_VERIFICATION=false` 固定。`zucker doctor` 检查密钥长度、origin 一致性、数据库可达和迁移状态。下面的 1–7 节是逐个生成单应用的方式，仍然有效。

## 1. 生成需要的应用

使用 Node.js 24.14.1、pnpm 11.25.0，在新产品的父目录执行。目录名只是示例，CLI 不覆盖已有目录；只需要其中一端时生成对应应用即可。

```sh
pnpm dlx @zucker-framework/cli@1.0.10 init my-server --template server-full
pnpm dlx @zucker-framework/cli@1.0.10 init my-admin --template admin
pnpm dlx @zucker-framework/cli@1.0.10 init my-web --template web
```

持久化 SaaS 明确选择 `server-full`；仓外的 `server` 是最小内存示例。生成物各自包含 README、AGENTS 和配置示例，不需要相邻 Framework 源码。首次安装后保留 lockfile，后续 CI 使用 `pnpm install --frozen-lockfile`。

## 2. 先启动数据库、Server 和管理员

在 Server 项目内安装依赖，编辑 **CLI 已生成的 `.env`**。其中 `JWT_SECRET` 和 `CONFIG_ENCRYPTION_KEY` 是两把独立随机密钥，保留它们；不要用 `.env.example` 覆盖整个文件。

| 配置 | 本地示例／用途 |
| --- | --- |
| `DATABASE_URL` | 本产品独立开发数据库；由产品所有者提供 |
| `PORT` | `4200` |
| `ACCOUNT_ORIGINS` | `http://localhost:4201,http://localhost:4202`，浏览器 origin，不含路径 |
| `WEB_URL` | `http://localhost:4202`，账户邮件链接和 OAuth 回调使用的 Web 地址 |

```sh
pnpm install
pnpm prisma:generate
pnpm db:migrate
```

这一步使用迁移链创建表和必要触发器，不用 schema push 代替。然后在私密配置中填写 `BOOTSTRAP_ADMIN_USERNAME`、`BOOTSTRAP_ADMIN_EMAIL`、`BOOTSTRAP_ADMIN_PASSWORD`，执行：

```sh
pnpm account:admin
pnpm dev
```

管理员初始化是显式一次性命令，不在启动时运行；拒绝覆盖或提升已有账户。创建成功后移除引导密码配置。该管理员已由初始化命令标记为已验证，因此可以先在没有 SMTP 的开发环境中检查管理端登录；普通注册、邮箱验证和找回密码仍需配置账户邮件。

查看 `http://localhost:4200/api/health/ready`，确认数据库检查的 `schemaReady` 为 `true`。这证明所需表可读取，不代表外部付款、邮件或存储已验证。

## 3. 接上两个前端

分别在 Admin、Web 项目中，将自己的 `.env.example` 复制为 `.env.local`，然后执行 `pnpm install`、`pnpm dev`。

| 应用 | 配置 | 默认入口 |
| --- | --- | --- |
| Admin | `API_PROXY_TARGET=http://localhost:4200`，**不带 `/api`** | `http://localhost:4201` |
| Web | `API_URL=http://localhost:4200/api`，**包含 `/api`** | `http://localhost:4202/zh` 或 `/en` |
| Web | `SITE_URL=http://localhost:4202`，与 Server `WEB_URL` 一致 | 用于公开站点地址 |

前端浏览器请求保持 `/api/*`。先用引导管理员登录，保存一次资料并刷新回读，再检查角色与权限入口；页面打开不等于保存成功。新增域名或端口时同步 Server 的 `ACCOUNT_ORIGINS`。

## 4. 按用途配置品牌、邮件和连接

| 要做的事 | 配置位置 | 生效与检查 |
| --- | --- | --- |
| 网站品牌、双语导航、主题与 SEO | Admin「内容与站点 → 站点配置」 | 保存后刷新 Web；Admin 自身标题、Logo 仍在消费者 UI 中定制 |
| 账户验证／找回／欢迎邮件与购买回执 | Server `MAIL_PROVIDER`（`smtp` 默认或 `resend`）、`SMTP_FROM`，以及 `SMTP_HOST/PORT/SECURE/USER/PASSWORD` 或 `MAIL_RESEND_API_KEY`；或后台账户邮件连接 | 配置后验证注册 → 收信 → 验证 → 登录；`SMTP_USER/PASSWORD` 都为空时不做 SMTP 认证 |
| 注册开关、邮箱验证、初始角色、欢迎积分、默认支付渠道 | Admin「系统设置 → 产品策略」（`account`、`billing`），或 `POLICY_<策略>_<字段>` 环境变量固定 | 保存后无需重启，最长 30 秒内生效；被环境变量固定的字段在后台只读 |
| 任务完成通知 | 独立的 `DELIVERY_PROVIDER` 为 `none`、`smtp` 或 `resend`，以及 `DELIVERY_*` 配置 | 默认 `none`；填账户 SMTP 不会自动开启持久任务通知 |
| 付款、OAuth、私有存储、AI 连接 | Admin「系统设置 → 连接配置」或 Server 的对应环境配置 | 后台保存后重启 Server，再核对已应用版本和真实渠道行为 |
| AI 生成（图片/视频/音乐）与对话、模型目录与定价 | Server AI 连接与 `AI_MEDIA_ADAPTERS`；Admin「AI → 模型与定价」（`ai-catalog`、`ai-pricing` 策略） | 策略保存后无需重启；详见 [AI 快速上手](ai-quickstart.md) |
| 分析、广告、联盟、客服 | 后台公开网站连接 | 默认 Web 的 `SITE_CONFIGURATION_SOURCE=server` 读取 Server 已应用快照；只改 Web 环境变量不会覆盖该来源 |

任务邮件的 SMTP、Resend 都需要 `DELIVERY_ACCOUNT_SCOPE` 和 `DELIVERY_FROM`；Resend 另配置 `DELIVERY_RESEND_API_KEY`，SMTP 另配置 `DELIVERY_SMTP_*`。账户邮件是即时发送，持久投递仓储的恢复保证只适用于实际接入它的任务通知。各字段和失败契约见[Server 模板说明](../templates/server/README.md)。

后台的连接配置（包括邮件与分析连接）保存后均需重启 Server；站点品牌、导航等内容设置保存后刷新 Web 即可。不要把“已保存”当作连接已经应用或供应商已经验证。

OAuth 应用登记的回调是 `WEB_URL/api/authorize/oauth/google/callback` 或 `WEB_URL/api/authorize/oauth/github/callback`；Google One Tap 另登记 Web origin。填写凭据后再启用对应开关，按实际登录、绑定和退出流程验收。

## 5. 配置商品后再验证收款

后台连接页负责渠道配置；套餐（含每期赠送积分）在 Admin「交易与额度 → 套餐」、积分包在「积分包」中编辑，`BILLING_CATALOG_JSON` 只在管理员初始化时作为一次性种子（积分包表为空时其一次性商品也作为后备在售）。公开价格接口 `GET /api/billing/plans` 返回 `{plans, packs, checkout}`（1.0.20 起；此前是数组）。价格页在渠道启用前把套餐标为“暂不可购买”。

每个商品包含 `id/title/version/mode/amount/currency/credits/providers`，可带 `expiresInDays`；金额用精确十进制字符串，积分是正整数。`mode` 为 `payment` 或 `subscription`。渠道引用含义如下：

| `providers` 字段 | 填什么 |
| --- | --- |
| `stripe` | 该环境的 Stripe Price ID |
| `creem` | 该环境的 Creem Product ID |
| `paypal` | 一次付款为 SKU；订阅为 Plan ID |

PayPal 订阅还要求显式 `subscriptionGrantBasis: {"paypal":"payment"}`，不能从付款收据推算供应商未证明的账期。商品只在对应渠道已启用、配置有效且支持该模式时出现在 `/pricing`。改商品配置只影响新订单，既有订单使用原冻结政策。

先使用测试渠道验证：选择商品 → 创建订单 → 测试付款 → 服务端确认／回调 → 权益回读；再分别验证续费、取消和退款。访问回跳 URL 的 `success` 参数不会自动发放权益。字段定义与完整接口以[商品目录实现](../templates/server/src/billing/catalog.ts)和 Server README 为准。

## 6. 写第一条自己的业务

从现有 `src/jobs/jobs.handlers.ts` 的中立 `record` 示例开始：

```json
{"kind":"record","input":{"value":"合成记录","notify":false}}
```

这份正文提交到 `POST /api/jobs`，需要已登录账户、允许的 Origin 和稳定的 `Idempotency-Key`。查询返回的任务 ID 与记录，后台「运行与审计 → 任务」可查看生命周期。测试通知前保留 `notify:false`。

真正的新业务在消费者中增加输入校验、数据模型和 handler，沿现有唯一 JobsHost 执行；不要再注册一套 worker。Framework 继续负责身份、持久任务、文件、账本等机制，消费者决定资源归属、收费时点、失败补偿和交付成功标准。这个示例不是生图、生视频或其他生成业务。

## 7. 验收、部署与后续升级

- 分别运行三个应用自己的 lint、类型与 build 命令；持久化测试使用该产品的隔离合成数据。检查失败后重试、刷新回读和普通成员访问范围。
- Admin 静态部署需要 SPA 路由回退和 `/api/*` 反向代理。Web standalone 同时保留 `.next/standalone`、复制进去的 `.next/static` 及存在的 `public`，显式配置运行端口和 API 地址。
- 新项目的 README/AGENTS 记录用途、目录、固定版本、环境、业务入口和已验收范围，让后续开发不依赖上一轮对话。
- 升级时同步直接依赖、传递依赖覆盖和 lockfile，并保留原密钥及消费者定制。候选 tarball 的 pnpm 11 覆盖写在 `pnpm-workspace.yaml`；正式依赖使用已发布的不可变版本。
- 新模板的迁移链属于新应用，不能直接重放到 CNIPA 或其他既有产品库。旧产品先做兼容包升级，再逐项决定是否接入新的宿主机制。

遇到问题时先查对应层：连不上 API 查前缀／origin；管理员能登录而注册失败查账户 SMTP；价格页为空查商品与渠道；连接已保存但仍用旧配置查 Server 是否重启；页面刷新后数据消失则检查实际持久接口与回读结果。
