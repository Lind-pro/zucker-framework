# Zucker Framework

企业级全栈 NestJS + Next.js TypeScript 框架，hsweb-framework 的 TypeScript 移植与增强版本。

---

## 特性亮点

- **6 层架构** -- 从基础类型到模板应用，层级清晰，禁止反向依赖
- **45+ 个包** -- 覆盖 CRUD、认证、缓存、队列、AI、IoT、支付等完整业务场景
- **3 套模板** -- Server (NestJS API)、Admin (React + Ant Design)、Web (Next.js)
- **统一事件总线** -- 本地 + 集群广播，支持 wildcard 订阅和操作 Hook
- **弹性容错** -- 断路器、自动重试、错误分类、优雅停机
- **多租户** -- 行级隔离 / Schema 隔离 / 数据源隔离三种策略
- **前后端共享** -- Zod Schema 一处定义，前后端共用类型验证
- **IoT 支持** -- 设备接入、时序数据、集群通信、网关协议

## 技术栈

| 类别 | 技术 |
|------|------|
| 运行时 | Node.js 20+ |
| 后端 | NestJS 11 + Prisma 6 |
| 前端 (Admin) | React 19 + Ant Design 5 |
| 前端 (Web) | Next.js 15 |
| 类型验证 | Zod v4 |
| 构建 | tsup + Turborepo |
| 测试 | Vitest + Playwright |
| 包管理 | pnpm 9 (workspace protocol) |

## 快速开始

### 前置要求

- Node.js 20+
- pnpm 9+
- PostgreSQL 15+ (可选，开发环境可用 InMemoryAdapter)
- Redis (可选，用于缓存和分布式锁)

### 安装与构建

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
pnpm dev:admin    # 启动管理后台 (端口 3100)
pnpm dev:web      # 启动 Web 前台
```

### 创建业务模块

```typescript
// Service -- 继承 BaseService 获得完整 CRUD
@Injectable()
export class ArticleService extends BaseService<Article> {
  constructor(
    @Inject(DATABASE_ADAPTER) db: DatabaseAdapter,
    dynamicQuery: DynamicQueryService,
  ) {
    super(db, dynamicQuery, 'article');
  }
}

// Controller -- 继承 BaseController 获得 10 个标准端点
@Controller('articles')
export class ArticleController extends BaseController(Article) {
  constructor(private readonly articleService: ArticleService) {
    super(articleService);
  }
}
```

详见 [快速开始指南](docs/getting-started.md)。

## 包目录

### Layer 1: 基础

| 包 | 说明 |
|----|------|
| `@zucker/core` | 异常层级、ID 生成、断路器、流式管道、VCR、Mailbox、迁移框架 |
| `@zucker/common` | 请求上下文 (AsyncLocalStorage)、全局过滤器/管道、优雅停机 |
| `@zucker/fe-types` | 前后端共享 Zod Schema，不依赖任何后端包 |

### Layer 2: 框架核心

| 包 | 说明 |
|----|------|
| `@zucker/crud` | BaseService + BaseController、动态查询、数据库适配器 (Prisma/InMemory) |
| `@zucker/auth` | JWT + Passport 认证、RBAC 权限、数据权限、2FA (TOTP) |
| `@zucker/event` | 实体生命周期事件、统一事件总线、操作 Hook 注册表 |
| `@zucker/logging` | 访问日志、结构化日志、审计日志、PII 自动脱敏 |

### Layer 3: 基础设施

| 包 | 说明 |
|----|------|
| `@zucker/config` | 分层配置、Zod 类型安全、热重载、Feature Flag 引擎 |
| `@zucker/cache` | 内存 / Redis / 混合缓存、标签化失效 |
| `@zucker/storage` | 文件存储 (Local / S3 / WebDAV) |
| `@zucker/notification` | 多渠道通知、Webhook 注册与可靠投递、HMAC 签名 |
| `@zucker/queue` | 消息队列、TaskLifecycleManager、DLQ |
| `@zucker/tenant` | 多租户隔离 (行级 / Schema 级 / 数据源级) |
| `@zucker/i18n` | 国际化 |
| `@zucker/ai` | AI 集成 (LangChain / LangGraph) |
| `@zucker/credit` | 积分系统 |
| `@zucker/payment` | 支付集成 |
| `@zucker/datasource` | 动态数据源管理 |
| `@zucker/dictionary` | 数据字典 |
| `@zucker/form` | 动态表单 |
| `@zucker/relation` | 数据关联 |
| `@zucker/search` | 搜索引擎集成 |
| `@zucker/rate-limiter` | 限流 |
| `@zucker/tracing` | 分布式追踪 |
| `@zucker/buffer` | 缓冲区管理 |

### Layer 4: 高级能力

| 包 | 说明 |
|----|------|
| `@zucker/admin` | 自动 REST API 生成、CrudControllerFactory |
| `@zucker/monitoring` | 指标采集、告警、UsageTracker |
| `@zucker/provider` | Provider 注册表、健康检查 |
| `@zucker/rule-engine` | 业务规则引擎 |
| `@zucker/script` | 脚本执行沙箱 |
| `@zucker/reference` | 数据引用管理 |
| `@zucker/dashboard` | 仪表盘 |
| `@zucker/gateway` | 网关协议 |

### Layer 4: IoT (物联网)

| 包 | 说明 |
|----|------|
| `@zucker/things` | 设备管理与接入 |
| `@zucker/timeseries` | 时序数据存储与查询 |
| `@zucker/network` | 网络协议 |
| `@zucker/io` | I/O 通信 |
| `@zucker/cluster` | 集群通信 |

### 前端包

| 包 | 说明 |
|----|------|
| `@zucker/fe-http-client` | 统一 HTTP 客户端，响应自动解包 |
| `@zucker/fe-auth` | 认证状态管理 (useAuthStore) |
| `@zucker/fe-permission` | 权限控制 (usePermission) |
| `@zucker/fe-storage` | 前端存储封装 |
| `@zucker/fe-form` | 动态表单 |
| `@zucker/fe-analytics` | 前端分析 |

### 工具

| 包 | 说明 |
|----|------|
| `@zucker/cli` | 脚手架 (init)、诊断 (doctor)、模块管理 (add/list/info) |

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
| [快速开始](docs/getting-started.md) | 从零创建项目完整指南 |
| [API 参考](docs/api-reference.md) | 各包导出的核心接口、类和函数 |
| [模块扩展](docs/extending-modules.md) | 如何添加更多业务功能 |
| [新模块指南](docs/new-modules-guide.md) | 新增模块使用示例 |
| [hsweb 映射表](docs/hsweb-mapping.md) | hsweb-framework 到 zucker 的对应关系 |

## 项目结构

```
zucker-framework/
├── packages/          # 45 个框架包
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
pnpm dev:admin         # 启动管理后台 (端口 3100)
pnpm dev:web           # 启动 Web 前台
pnpm clean             # 清理构建产物
```

## 在外部项目中使用

通过 `pnpm-workspace.yaml` 引用框架目录：

```yaml
packages:
  - 'apps/*'
  - 'packages/*'
  - '../zucker-framework/packages/*'
```

所有 `@zucker/*` 包即可通过 `workspace:*` 协议引用。

## License

Apache-2.0
