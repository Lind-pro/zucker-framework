# 基于 Framework 创建新项目

本指南用于创建独立的业务应用。AI 开工前先读 [项目初始化技能](../.agents/skills/framework-project-bootstrap/SKILL.md) 和 [能力归属约束](architecture.md#新增能力的归属与接入)。新项目使用 Framework 的公开能力，业务代码和项目自己的约束属于新仓库。

## 1. 确定最小项目范围

从用户请求确认项目目录、用途、首个业务流程，以及需要 Server、Admin、Web 中的哪些部分。只需要后端就先建一个应用；确实需要多个应用时再使用 apps/packages 工作区，不默认复制完整框架或已有业务项目。

涉及持久化时确认本项目的开发数据库及其他必要依赖。缺少这些信息时可先完成不依赖它们的骨架与配置说明，但不能借用其他产品的数据库、账号、密钥、付费服务或生产环境。

工具版本从 manifest 读取：本仓库当前使用 pnpm `11.25.0`，要求 Node.js `>=22.22.0`，CI 使用 Node.js `24.14.1`。新项目选择与所用包兼容的版本，并写入自己的 `packageManager`/`engines`。不要沿用旧文档的 Node 20、pnpm 9 或旧 Nest/Prisma 示例。

## 2. 选择真实可用的初始化入口

### 独立 Server 骨架

在目标项目的父目录执行，`my-app` 换成实际项目名：

```sh
pnpm dlx @zucker-framework/cli@1.0.2 init my-app --template server
cd my-app
```

`1.0.2` 是当前已发布的 CLI 示例版本；后续先核对发布信息再选定明确版本，不使用 `latest`。当前安装版 CLI 自带最小 Server 骨架，不要求相邻 Framework 源码。

该骨架包含 package.json、TypeScript/Nest 配置、基础模块装配和私密本地 JWT 密钥。默认端口是 `4200`，API 前缀是 `/api`；它还没有业务模型或完整登录/权限产品。默认 `InMemoryAdapter` 只用于演示，不能据此宣称账户、订单或任务能持久保存。不要在日志中输出生成的密钥。

初始化后先完成下节的项目约束和配置核对，再安装依赖、启动：

```sh
pnpm install
pnpm dev
```

保留 lockfile；后续 CI 使用 `pnpm install --frozen-lockfile`。一次成功启动只证明骨架可运行，不代替首个业务流程验收。

### Admin / Web / 完整 Server 模板

当前安装版 CLI 的 `--template admin`、`--template web` 需要 Framework checkout 中的模板；不要把这两个选项描述成已经发布的独立生成器。仓库模板分别位于 `templates/admin`、`templates/web`、`templates/server`。

已有对应开发构建的 checkout 时，在目标父目录调用其 CLI，例如：

```sh
node /path/to/zucker-framework/packages/cli/dist/index.js init my-admin --template admin
```

若 CLI 产物缺失，先按 Framework 本地工作流准备该工具；不要默认构建所有模板。CLI 会将复制模板中的 `workspace:*` 改为 catalog 中的确切版本，但仍须检查配置中的仓库相对路径和运行前置条件。

当前 Admin 模板的 `vite.config.ts` 将 `@zucker-framework/fe-form` 指向框架源码。外部新项目要移除该源码别名，使用公开包；检查所有 `../../packages`、tsconfig extends、构建脚本和资源路径，不把本机目录关系带入新项目。不要只做 `cp -r` 后就声称项目已独立。

模板自身开发入口当前使用 Server `4200`、Admin `4201`、Web `4202`；新项目的端口、API 地址及回调由新项目明确配置，以实际脚本和启动输出为准。

## 3. 让新项目有自己的 AI 入口

**Framework 的根 AGENTS.md 不会自动成为外部项目的约束。当前 CLI 1.0.2 也不会生成这些文件，初始化 AI 必须补齐。**

- 将 [消费者 AGENTS 模板](templates/consumer-AGENTS.md) 按实际项目调整后放入新项目根目录 `AGENTS.md`。它规定“先查 Framework，再判断机制与业务归属”，并且不依赖相邻源码目录。
- 需要兼容 Claude 时，在支持符号链接的环境中创建 `CLAUDE.md -> AGENTS.md`，避免维护两套规则。已有用户约束要保留并合并；不要覆盖。
- 写一份简短 README，说明产品用途、实际目录、采用的 Framework 包和版本、可执行的开发/检查命令、本项目开发依赖与当前验收状态。小项目不需要另外创建空的架构层或大量文档。
- 不复制 Framework 的维护者 AGENTS.md，也不复制 CNIPA 的环境、套餐、专利规则或执行器部署约束到新项目。

例如，新应用可以把业务代码共置在 `src/modules/<feature>`，基础设施接入放 `src/infrastructure`；有前端时按功能组织。目录按实际规模选择，模板中的通用边界必须落实到当前项目的真实路径和命令。

## 4. 按需选择 Framework 能力

使用 [能力导航](../.agents/skills/framework-development/references/package-map.md) 查找候选包，然后核对公开 exports、类型、peerDependencies、相关测试及消费者所用版本。不要通过复制库实现来绕过接口或版本缺口。

- 新项目只安装实际使用的能力。Framework 依赖固定到已发布版本，不使用 `latest`、默认跨仓 `workspace:*`、内部源码路径或移动分支作为正式输入。
- CLI catalog 是生成时的版本基线，不保证包含之后的修复。当前 media/logging 的 `1.0.3` 是兼容补丁；采用它们时也要按 [发布说明](package-release.md) 检查间接依赖，避免同时加载两个日志/Nest/SDK 实例。
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

`zucker doctor` 仅提供初步静态提示，不是验收门禁；当前 1.0.2 会展示环境变量值的前缀，不应带真实凭据自动运行。发布、镜像与生产部署是后续单独阶段，不因初始化成功自动执行。

## 交付给后续 AI 的信息

最终说明项目位置、已有功能、Framework 复用点及版本、AI 入口、启动/检查方法和明确的缺口。后续 AI 从新项目自身的 AGENTS.md 与 README 继续工作，无需知道框架仓库在上一台机器上的绝对路径。
