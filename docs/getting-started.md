# 基于 Framework 创建新项目

本指南用于创建独立的 Framework 消费者。AI 开工前先读 [项目初始化技能](../.agents/skills/framework-project-bootstrap/SKILL.md) 和 [能力归属约束](architecture.md#新增能力的归属与接入)。新项目使用 Framework 的公开能力，业务代码和项目自己的约束属于新仓库。

首次启动可先按[新 SaaS 落地手册](saas-quickstart.md)完成生成、数据库迁移、管理员、前端连接和首条业务；本页保留完整的制品与接入边界。

**2026-10-24 状态：** Admin/Web/server-full已完成本地固定制品的独立初始化与运行验收：35个Framework包、13条真实迁移、98项持久契约及10类浏览器流程通过；真实公共配置补丁升级/回退保留消费者定制。新CLI与配套包尚未发布，不能把源码manifest版本或注册表旧同名版本当成这些新能力。真实供应商账号与生产部署仍需分别配置和验收。

## 1. 确定最小项目范围

从用户请求确认项目目录、用途、首个业务流程，以及需要 Server、Admin、Web 中的哪些部分。只需要后端就先建一个应用；确实需要多个应用时再使用 apps/packages 工作区，不默认复制完整框架或已有业务项目。

涉及持久化时确认本项目的开发数据库及其他必要依赖。缺少这些信息时可先完成不依赖它们的骨架与配置说明，但不能借用其他产品的数据库、账号、密钥、付费服务或生产环境。

工具版本从 manifest 读取：本仓库当前使用 pnpm `11.25.0`，要求 Node.js `>=22.22.0`，CI 使用 Node.js `24.14.1`。新项目选择与所用包兼容的版本，并写入自己的 `packageManager`/`engines`。不要沿用旧文档的 Node 20、pnpm 9 或旧 Nest/Prisma 示例。

## 2. 区分已安装制品与本地初始化实现

使用已发布 CLI 时先核对该版本的实际文件和支持范围，不使用 `latest` 推断能力。旧版 `1.0.2` 的独立最小 Server 示例仍可作为历史入口；它不包含本节新增的 Admin/Web bundle 与消费者指令安装。源码 manifest 的版本号、catalog 中的版本和注册表已发布制品是不同证据。

### 本地源码的模板选择

| 模板 | 当前本地实现的数据来源 | 能力边界 |
| --- | --- | --- |
| `admin` | CLI 随附的 `project-templates.json` bundle | 在 Framework checkout 外也使用相同资产；不回退到相邻源码目录；仍需对应 Server 与权限接入 |
| `web` | 同一 CLI bundle | 自带现有前台、国际化与本地配置；不依赖相邻 Framework 源码；账户等功能仍需接入 Server |
| `server-full` | CLI bundle 中由当前 `templates/server` 准备的完整资产 | 包含账户装配、Prisma schema/迁移、配置和开发工具；必须配置自己的 PostgreSQL、JWT 与邮件，不回退为内存演示 |
| `server` | 找到仓内 `templates/server` 时保持原复制行为；找不到时生成原有最小骨架 | 仅保留原有兼容行为；需要不受 checkout 位置影响的完整 Server 时明确选择 `server-full` |

Admin/Web/server-full 所需 bundle 缺失、资产非法或 `workspace:*` 依赖没有 catalog 版本时，初始化报错，不悄悄复制另一份附近模板。CLI 拒绝已存在的目标目录，不覆盖已有项目。

已准备与本地源码匹配的 CLI 开发产物时，在目标项目的父目录执行所需命令，例如：

```sh
node /path/to/zucker-framework/packages/cli/dist/index.js init my-admin --template admin
node /path/to/zucker-framework/packages/cli/dist/index.js init my-web --template web
node /path/to/zucker-framework/packages/cli/dist/index.js init my-server --template server-full
# 保留的最小骨架兼容入口（仓外）：
node /path/to/zucker-framework/packages/cli/dist/index.js init my-minimal-server --template server
```

不要求一次创建三个项目。此处绝对路径只用于选择初始化工具，生成的 Admin/Web/server-full 不以该 checkout 为运行依赖。CLI 产物应包含 `release-catalog.json` 与 `project-templates.json`；缺少时按 [本地工作流](runbooks/agent-development-workflow.md) 准备对应工具，不默认构建全部模板。

CLI 将模板开发时的 `workspace:*` 替换为 catalog 中的确切版本，并写入 catalog 的 Node/package-manager 基线。生成成功只证明写入了项目文件：安装前仍需确认这些版本有可消费制品。模板 bundle 包含源码、根配置、README、`.env.example` 和忽略规则，排除依赖目录、构建缓存、私有环境文件、上传数据、自动生成的 Prisma Client 和 Next 类型文件。

在生成的 Admin/Web 项目内，先核对自己的配置与 AGENTS，再执行：

```sh
pnpm install
pnpm dev
```

保留本项目 lockfile，CI 使用 `pnpm install --frozen-lockfile`。直接复制仍含 `workspace:*` 的仓库目录不等同于独立初始化；本地源码联调与固定制品安装验证分别记录。

### 完整 Server 的必要准备

`--template server-full` 随包提供 `prisma/schema.prisma`、迁移目录及锁文件、`prisma.config.ts`、账户模块和显式管理员初始化命令；不复制已生成的 Prisma Client、私密环境或上传文件。目录创建成功不等于账户服务已经可运行。

1. 安装与该 CLI 资产匹配的固定包。本轮新增的持久刷新和管理权限契约尚未发布；验证当前源码时使用明确的本地固定 tarball/完整性与 lockfile，不把注册表同名版本冒充新 API。正式独立交付仍需对应不可变制品。
2. 使用 CLI 新建的 `0600` 私密 `.env`；JWT_SECRET 与 CONFIG_ENCRYPTION_KEY 已分别独立随机生成且不打印。填写本项目 PostgreSQL `DATABASE_URL`、ACCOUNT_ORIGINS 与 WEB_URL，并补 SMTP；数据库/邮件凭据保持显式配置，不沿用另一个产品的账号或环境。不要用 `.env.example` 覆盖已生成的密钥。
3. 执行 `pnpm prisma:generate` 和 `pnpm db:migrate`。迁移包含账户表和凭据版本触发器，不能用 schema push 省略迁移；生成 Client 不代表数据库已迁移。
4. 执行 `pnpm dev`，缺数据库会明确失败。SMTP 不是启动依赖；首次管理员由应用所有者按生成项目 README 显式执行 `pnpm account:admin`，可先检查管理端登录，启动没有默认账号或密码副作用。启用普通注册/验证/找回前再配置账户 SMTP；缺少配置时邮件操作返回不可用。任务通知使用独立 `DELIVERY_*` 配置，不与账户邮件自动共用。
5. 使用随项目提供的 ESLint 配置运行 `pnpm lint`；数据库集成检查按 README 的隔离测试要求执行。账户后端验证与生成项目安装、迁移、真实前端使用分别记录，不相互替代。

完整 Server 将入口使用的 `dotenv` 声明为运行时依赖。生产裁剪开发依赖前仍需完成 Prisma Client 生成与应用编译，并保留生成后的 `dist`；`prisma`、`tsx` 和管理员初始化开发命令不属于仅安装生产依赖后的运行保证。

最终独立验收使用35个Framework包的固定tarball、已安装CLI生成的三个消费者及各自pnpm11 lockfile。真实执行Prisma generate和13条migrate deploy，Server/Admin/Web各自构建与运行通过；98项持久契约零失败/零跳过，10类实际浏览器流程与140次API响应无错误。配置包从真实registry 1.0.8升级到本地真实隐私补丁，再回退原tarball，原加密profile仍可读、消费者定制保持完整，回退lock与基线相同。测试资源已清理，未调用真实收费/邮件/存储渠道；这些制品仅为本地验证输入，不能发布覆盖原版本。

### 本地端口与 API 接入

| 应用 | 默认开发入口 | 配置与转发 |
| --- | --- | --- |
| Server | `http://localhost:4200` | API 前缀 `/api`，监听端口可由 `PORT` 配置；数据库、凭据与其他服务由本消费者配置 |
| Admin | `http://localhost:4201` | `.env.example` 复制为 `.env.local`；`API_PROXY_TARGET=http://localhost:4200` 填后端 origin，不带 `/api`；浏览器仍请求 `/api/*`，Vite 开发代理保留前缀 |
| Web | `http://localhost:4202/zh` 或 `/en` | `.env.example` 复制为 `.env.local`；`API_URL=http://localhost:4200/api` 填包含前缀的完整 API 基址；Next 将浏览器 `/api/*` 转发到该基址 |

两个前端地址参数均由服务端配置读取，不需要公开为浏览器环境变量。Admin 只保留项目内 `@/* → src/*` 别名，`fe-form` 等从公开包解析；类型、ESLint、Web 的 PostCSS/Tailwind 与国际化配置随项目提供。

Admin 的开发代理不是生产反向代理：静态托管需配置 `/api/*` 转发和 SPA 路由回退。Web 的 `pnpm start` 仍使用 Next 的默认监听规则（`PORT` 或 `3000`），不能把开发端口 `4202` 当作所有部署方式的默认值；rewrite 配置也需纳入部署配置。

最小 Server fallback 会生成权限为 `0600` 的本地 JWT 密钥文件，但仍使用 `InMemoryAdapter`。仅填写 `DATABASE_URL` 不会自动把这份 fallback 改成持久化 Server；需由消费者接入公开 adapter/port 并验证迁移、账号和权限。不要打印生成的密钥，也不把页面可访问或骨架成功启动写成登录、支付、文件及通知已经打通。

### 固定本地制品与 standalone 运行

使用本地tarball验证尚未发布的包时，pnpm11的依赖覆盖写在消费者`pnpm-workspace.yaml`的`overrides`中；package.json里的旧`pnpm.overrides`不会生效。核对直接与间接Framework包的实际解析来源，避免同版本旧registry包和新本地产物混装。正式消费以不可变已发布版本和项目lockfile为准。

Web完整依赖安装下的`pnpm start`已验证。当前Next配置输出standalone产物，裁剪部署时使用`.next/standalone/server.js`，并把`.next/static`复制到`.next/standalone/.next/static`；项目存在public目录时也复制到standalone目录。通过PORT/HOSTNAME指定监听，通过应用配置指定API基址。专用入口的登录、账户、公开页及14个JS/CSS资源已验证；不能仅复制server.js而遗漏静态资源。

## 3. 让新项目有自己的 AI 入口

Framework 根 AGENTS.md 不会自动成为外部项目约束。当前本地 `init` 在 Admin、Web、server-full、仓内 Server 复制及最小 Server fallback 路径结束时，均调用消费者指令安装器：

- 安装 bundle 携带的 [消费者 AGENTS 模板](templates/consumer-AGENTS.md)，不复制 Framework 维护者约束。
- 尝试创建相对符号链接 `CLAUDE.md → AGENTS.md`；文件系统不支持时保留 AGENTS 并警告，不复制第二份可能漂移的规则正文。
- 安装器保留已有 AGENTS/CLAUDE 文件；已有非标准 Claude-only 规则时提示显式合并，不自动新增相互竞争的规则。`init` 本身仍拒绝已有目标目录。
- 初始化后把项目用途、实际目录、必要环境、所用固定包版本和验证状态补进本项目 README/AGENTS；安装通用模板不代表产品政策已填写。不要复制另一产品的数据库、账号、凭据或部署约束。

这些安装行为尚待随新 CLI 制品发布。使用旧 CLI 或手工创建的消费者时，检查文件实际是否存在；缺少时按模板补齐，并保留用户原有约束。消费者自身指令与 README 应能独立工作，不要求后续 AI 知道 Framework checkout 在哪台机器的哪个目录。

## 4. 按需选择 Framework 能力

使用 [能力导航](../.agents/skills/framework-development/references/package-map.md) 查找候选包，然后核对公开 exports、类型、peerDependencies、相关测试及消费者所用版本。不要通过复制库实现来绕过接口或版本缺口。

- 新项目只安装实际使用的能力。Framework 依赖固定到已发布版本，不使用 `latest`、默认跨仓 `workspace:*`、内部源码路径或移动分支作为正式输入。
- CLI catalog 是生成时的版本基线，不保证其中源码版本均已发布，也不自动包含之后的修复。按 [发布说明](package-release.md) 核对确切制品及间接依赖，避免同时加载两个日志/Nest/SDK 实例。
- `zucker add` 当前会执行未指定版本的安装并打印示例配置；需要参考时用 `--dry-run`，实际依赖和配置仍由核对后的公开契约决定。
- HTTP/SSE、认证状态、通用持久化、存储、日志和渲染复用 Framework；产品准入、所有权策略、模型字段、业务流程、Prompt、价格与 UI 由应用持有。
- 全局基础设施只装配一次。浏览器使用浏览器安全的公开入口；服务器能力和原生 SDK 不进入客户端包。

源码联调是可选开发方式，必须与默认 npm 模式区分。新增通用能力需要修改 Framework 时，先完成授权范围内的实现和验证，再按对应制品发布/固定归档方式接入应用，不能悄悄保留双实现。

## 5. 实现并验收第一个业务流程

先选一个真实的小流程，例如“保存一条属于当前用户的业务记录并重新读取”，而非一次安装所有模块：

1. 定义应用自己的模型、DTO 和业务规则；核对 CRUD/认证公开契约是否合适，特殊业务端点无需强行继承全部 CRUD。
2. 需要持久化时，按实际 adapter/port 绑定本项目的数据源和事务。不要从旧指南复制 Prisma 5 schema 或默认 JWT secret；以所选版本的配置方式为准。
3. 验证正常请求、输入错误、所有权拒绝，以及数据是否按约定保存。测试内存演示只能标为演示通过。
4. 前端验证实际 API 路径、登录/刷新/退出（若使用）和首个页面流程，检查浏览器错误及服务端结果。
5. 按应用脚本执行相关测试和类型/lint 检查。没有测试脚本时应明确说明并补上首个行为验证，不能写一个空 test 命令冒充验收。

`zucker doctor` 仅提供初步静态提示，不是验收门禁；本轮核对的源码仍会展示环境变量值的前缀，不应带真实凭据自动运行。发布、镜像与生产部署是后续单独阶段，不因初始化成功自动执行。

本地配置回归可使用 Admin/Web 各自的 `node --test config.test.mjs`；它验证代理映射与配置接线，不验证真实登录、支付、存储或通知。通用最小消费者的上述本地接入与持久化已验收；具体新产品仍须验证自己的政策和提供方配置，配置测试不能代替它们。

## 交付给后续 AI 的信息

最终说明项目位置、已有功能、Framework 复用点及版本、AI 入口、启动/检查方法和明确的缺口。后续 AI 从新项目自身的 AGENTS.md 与 README 继续工作，无需知道框架仓库在上一台机器上的绝对路径。
