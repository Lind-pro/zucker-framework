# Zucker Framework

企业级全栈 NestJS + Next.js TypeScript 框架，提供模块化后端能力与前端应用模板。

---

## 特性亮点

- **分层架构** -- 从基础类型到模板应用，层级清晰，禁止反向依赖
- **模块化公共包** -- 覆盖 CRUD、认证、缓存、队列、AI、IoT、支付等完整业务场景
- **3 套模板** -- Server (NestJS API)、Admin (React + Ant Design)、Web (Next.js)
- **统一事件总线** -- 本地 + 集群广播，支持 wildcard 订阅和操作 Hook
- **弹性容错** -- 断路器、自动重试、错误分类、优雅停机
- **多租户** -- 行级隔离 / Schema 隔离 / 数据源隔离三种策略
- **前后端共享** -- Zod Schema 一处定义，前后端共用类型验证
- **IoT 支持** -- 设备接入、时序数据、集群通信、网关协议

## 技术栈

| 类别 | 技术 |
|------|------|
| 运行时 | Node.js >=22.22.0，CI 使用 24.14.1 |
| 后端 | NestJS 12 + Prisma 7 |
| 前端 (Admin) | React 19 + Ant Design 5 |
| 前端 (Web) | Next.js 16 |
| 类型验证 | Zod v4 |
| 构建 | tsup + Turborepo |
| 测试 | Vitest + Playwright |
| 包管理 | pnpm 11.25.0；外部应用默认使用正式 npm 包 |

## 快速开始

创建独立业务项目先读 [新项目指南](docs/getting-started.md)；让 AI 初始化时使用 [framework-project-bootstrap](.agents/skills/framework-project-bootstrap/SKILL.md)。下面的源码构建命令用于开发 Framework 本身。

### 前置要求

- Node.js >=22.22.0（推荐与 CI 一致的 24.14.1）
- pnpm 11.25.0
- PostgreSQL 15+ (可选，开发环境可用 InMemoryAdapter)
- Redis (可选，用于缓存和分布式锁)

### 开发 Framework 本身

```bash
git clone <repo-url> zucker-framework
cd zucker-framework
pnpm install
pnpm build
pnpm test
```

### 启动模板应用

```bash
pnpm dev:server   # 启动后端 API (端口 4200)
pnpm dev:admin    # 启动管理后台 (端口 4201)
pnpm dev:web      # 启动 Web 前台 (端口 4202)
```

### 让 AI 创建业务项目

[初始化技能](.agents/skills/framework-project-bootstrap/SKILL.md)规定能力选择、项目边界、固定依赖和首个流程验收，并要求把[消费者约束模板](docs/templates/consumer-AGENTS.md)落实为新项目自己的 AGENTS.md。当前 CLI 不会自动写入这些约束。具体入口及模板限制见[新项目指南](docs/getting-started.md)。

## 包目录

### Layer 1: 基础

| 包 | 说明 |
|----|------|
| `@zucker-framework/core` | 异常层级、ID 生成、断路器、流式管道、VCR、Mailbox、迁移框架 |
| `@zucker-framework/common` | 请求上下文 (AsyncLocalStorage)、全局过滤器/管道、优雅停机 |
| `@zucker-framework/fe-types` | 前后端共享 Zod Schema，不依赖任何后端包 |

### Layer 2: 框架核心

| 包 | 说明 |
|----|------|
| `@zucker-framework/crud` | BaseService + BaseController、动态查询、数据库适配器 (Prisma/InMemory) |
| `@zucker-framework/auth` | JWT + Passport 认证、RBAC 权限、数据权限、2FA (TOTP) |
| `@zucker-framework/event` | 实体生命周期事件、统一事件总线、操作 Hook 注册表 |
| `@zucker-framework/logging` | 访问日志、结构化日志、审计日志、PII 自动脱敏 |

### Layer 3: 基础设施

| 包 | 说明 |
|----|------|
| `@zucker-framework/config` | 分层配置、Zod 类型安全、热重载、Feature Flag 引擎 |
| `@zucker-framework/cache` | 内存 / Redis / 混合缓存、标签化失效 |
| `@zucker-framework/storage` | 文件存储 (Local / S3 / WebDAV) |
| `@zucker-framework/notification` | 多渠道通知、Webhook 注册与可靠投递、HMAC 签名 |
| `@zucker-framework/queue` | 消息队列、TaskLifecycleManager、DLQ |
| `@zucker-framework/tenant` | 多租户隔离 (行级 / Schema 级 / 数据源级) |
| `@zucker-framework/i18n` | 国际化 |
| `@zucker-framework/ai` | AI 集成 (LangChain / LangGraph) |
| `@zucker-framework/credit` | 积分系统 |
| `@zucker-framework/payment` | 支付集成 |
| `@zucker-framework/datasource` | 动态数据源管理 |
| `@zucker-framework/dictionary` | 数据字典 |
| `@zucker-framework/form` | 动态表单 |
| `@zucker-framework/relation` | 数据关联 |
| `@zucker-framework/search` | 搜索引擎集成 |
| `@zucker-framework/rate-limiter` | 限流 |
| `@zucker-framework/tracing` | 分布式追踪 |
| `@zucker-framework/buffer` | 缓冲区管理 |

### Layer 4: 高级能力

| 包 | 说明 |
|----|------|
| `@zucker-framework/admin` | 自动 REST API 生成、CrudControllerFactory |
| `@zucker-framework/monitoring` | 指标采集、告警、UsageTracker |
| `@zucker-framework/provider` | Provider 注册表、健康检查 |
| `@zucker-framework/rule-engine` | 业务规则引擎 |
| `@zucker-framework/script` | 脚本执行沙箱 |
| `@zucker-framework/reference` | 数据引用管理 |
| `@zucker-framework/dashboard` | 仪表盘 |
| `@zucker-framework/gateway` | 网关协议 |

### Layer 4: IoT (物联网)

| 包 | 说明 |
|----|------|
| `@zucker-framework/things` | 设备管理与接入 |
| `@zucker-framework/timeseries` | 时序数据存储与查询 |
| `@zucker-framework/network` | 网络协议 |
| `@zucker-framework/io` | I/O 通信 |
| `@zucker-framework/cluster` | 集群通信 |

### 前端包

| 包 | 说明 |
|----|------|
| `@zucker-framework/fe-http-client` | 统一 HTTP 客户端，响应自动解包 |
| `@zucker-framework/fe-auth` | 认证状态管理 (useAuthStore) |
| `@zucker-framework/fe-permission` | 权限控制 (usePermission) |
| `@zucker-framework/fe-storage` | 前端存储封装 |
| `@zucker-framework/fe-form` | 动态表单 |
| `@zucker-framework/fe-analytics` | 前端分析 |

### 工具

| 包 | 说明 |
|----|------|
| `@zucker-framework/cli` | 脚手架 (init)、诊断 (doctor)、模块接入提示 (add) |

## 模板应用

| 模板 | 路径 | 说明 |
|------|------|------|
| Server | `templates/server/` | NestJS API 后端模板 |
| Admin | `templates/admin/` | React + Ant Design 管理后台模板 |
| Web | `templates/web/` | Next.js + i18n + SEO 前台模板 |

## 文档

| 文档 | 说明 |
|------|------|
| [架构设计](docs/architecture.md) | 分层架构、设计模式、安全架构 |
| [快速开始](docs/getting-started.md) | AI/开发者创建独立项目、选择能力与验收 |
| [消费者 AI 约束模板](docs/templates/consumer-AGENTS.md) | 新项目 AGENTS.md 的起点 |
| [API 参考](docs/api-reference.md) | 各包导出的核心接口、类和函数 |
| [模块扩展](docs/extending-modules.md) | 如何添加更多业务功能 |
| [新模块指南](docs/new-modules-guide.md) | 新增模块使用示例 |

## 项目结构

```
zucker-framework/
├── packages/          # 框架公共包
│   ├── core/          # L1 基础
│   ├── common/        # L1 请求上下文
│   ├── crud/          # L2 CRUD 核心
│   ├── auth/          # L2 认证授权
│   ├── ...
│   └── cli/           # CLI 工具
├── templates/         # 3 个模板应用
│   ├── server/
│   ├── admin/
│   └── web/
├── docs/              # 框架文档
├── turbo.json         # Turborepo 构建编排
└── package.json
```

## 常用命令

```bash
pnpm install           # 安装依赖
pnpm build             # 构建所有包
pnpm test              # 运行所有测试
pnpm lint              # 代码检查
pnpm dev:server        # 启动后端 (端口 4200)
pnpm dev:admin         # 启动管理后台 (端口 4201)
pnpm dev:web           # 启动 Web 前台 (端口 4202)
pnpm clean             # 清理构建产物
```

## 在外部项目中使用

默认选择明确发布的 npm 版本，保留应用自己的 lockfile。例如从目标父目录创建最小 Server：

```sh
pnpm dlx @zucker-framework/cli@1.0.2 init my-app --template server
```

然后按[新项目指南](docs/getting-started.md)补齐本项目的 AI 约束、开发配置和首个业务流程。Admin/Web 的完整模板目前需要 Framework checkout；复制后须处理源码别名等仓库相对配置。

跨仓 workspace 只用于明确的源码联调。新项目的正常安装与正式构建不依赖相邻 Framework 目录。

## License

Apache-2.0
