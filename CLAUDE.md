# Zucker Framework — 项目上下文

## 项目概述

全栈 NestJS + Next.js TypeScript 框架，hsweb-framework 的 TypeScript 移植与增强版本。
包含 46 个包（45 个库 + 1 个 CLI）和 3 个模板应用。

## 技术栈

- **运行时**: Node.js 20+
- **包管理**: pnpm 9.15.0 (workspace protocol)
- **构建**: tsup (库) + Turbo (编排)
- **测试**: Vitest (单元) + Playwright (E2E)
- **后端**: NestJS 11 + Prisma 6
- **前端**: React 19 + Ant Design 5 (admin), Next.js (web)
- **类型验证**: Zod v4

## 常用命令

```bash
pnpm dev:server        # 启动后端 (端口 4200)
pnpm dev:admin         # 启动管理后台 (端口 3100)
pnpm test              # 运行所有测试
pnpm build             # 构建所有包
npx vitest run packages/xxx/src/xxx.spec.ts  # 运行单个测试
```

## 架构分层

```
L1 基础:    core, common, fe-types
L2 核心:    crud, auth, event, logging
L3 基础设施: config, cache, storage, notification, queue, tenant, ...
L4 高级:    admin, monitoring, provider, rule-engine, ...
工具:       cli
```

详见 `docs/architecture.md`。

## 代码约定

### 模块结构
- 每个包在 `packages/<name>/` 下
- 入口文件: `src/index.ts` (barrel export)
- 构建产物: `dist/` (CJS + ESM + .d.ts)
- NestJS 模块统一使用 `forRoot()` / `forRootAsync()` 模式

### 导出约束
- 所有包的 `package.json` 都有 `exports` 字段
- 消费方只能从包根路径导入，不能引用内部文件

### 测试约定
- 测试文件: `*.spec.ts` (与源文件同目录)
- 使用 `InMemoryAdapter` 替代真实数据库
- `vitest.setup.ts` 提供 Reflect.metadata polyfill

### TypeScript
- 严格模式 (`strict: true`)
- 目标: ES2022, 模块: ESNext
- 装饰器: `experimentalDecorators` + `emitDecoratorMetadata`

### 关键约束
- `@zucker/core` 不依赖 NestJS（保持纯 TypeScript）
- `@zucker/fe-types` 不依赖任何后端包
- JWT Secret 在非开发环境必须显式配置，否则启动报错
- ESLint 禁止库包中直接使用 `process.env`（使用 ConfigService）

## 最近改进

四轮架构改进共新增 32 个模块（6,741 行代码），对标 Claude Code 架构模式：

### 核心基础设施
- **RequestContext**: AsyncLocalStorage 统一请求上下文
- **UnifiedEventBus**: 本地+集群事件总线
- **OperationHookRegistry**: 通用操作前后 Hook
- **CircuitBreaker**: 三态断路器
- **ErrorClassifier**: Prisma 错误分类 + withRetry 自动重试
- **TypedConfig**: Zod 类型安全配置 + 分层合并 + 环境变量加载

### 缓存与数据
- **TaggedCache**: 标签化缓存失效
- **MigrationRunner**: 幂等数据迁移框架

### 安全与合规
- **PiiFilter**: PII 自动识别脱敏
- **AuditLogger**: 不可变审计日志
- **FeatureFlagService**: 四层 Feature Flag 引擎

### 通信与任务
- **WebhookRegistry**: HMAC 签名 + 可靠投递 + 投递追踪
- **TaskLifecycleManager**: 后台任务状态机 + DLQ
- **Mailbox**: Actor 模式消息路由

### DX 工具
- **@zucker/cli**: init/doctor/add/list/info 五个命令
- **ConfigFileWatcher**: 配置文件热重载
- **withVcrFixture**: 测试固件录制/回放
- **Stream Pipeline**: 12 个 AsyncGenerator 组合工具
- **GracefulShutdownManager**: 阶段式优雅停机
- **CrudControllerFactory**: 声明式 CRUD 控制器生成

详见 `docs/new-modules-guide.md`。

## 文档索引

| 文档 | 内容 |
|------|------|
| `docs/architecture.md` | 架构设计、分层、设计模式 |
| `docs/new-modules-guide.md` | 新增模块使用示例（19 个模块） |
| `docs/getting-started.md` | 快速开始 |
| `docs/api-reference.md` | 全量 API 参考 |
| `docs/extending-modules.md` | 模块扩展指南 |
| `docs/hsweb-mapping.md` | hsweb → zucker 映射表 |
