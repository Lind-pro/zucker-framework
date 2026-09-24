# Zucker Framework 架构设计

> 全栈 NestJS + Next.js TypeScript 框架，提供模块化后端能力与前端应用模板。

## 新增能力的归属与接入

本节是新增能力和修改模块边界前的必读契约。后文的架构图和代码示例用于导航；具体 API、依赖及运行语义以当前 manifest、公开 exports、类型和测试为准，不把示例当作已经发布的接口保证。

1. **先确定机制，再找拥有者。** 明确消费者实际缺少的行为，搜索现有包和调用点。已有机制直接复用或在原包补齐；不要另起同名 Service、复制一份实现或先建新包。新抽象需要产品中立契约，以及第二个消费者或明确的安全/可靠性理由。
2. **消费者保留策略。** Framework 持有会话、账本、任务生命周期、存储、通知和渲染等可复用机制；用户准入、资源所有权政策、套餐/价格、业务任务含义、Prompt、邮件受众、文书规则和环境值由消费者决定。跨前后端共享的某个产品类型仍归该产品，不进入通用 `fe-types`。
3. **用端口连接数据。** 通用持久化接口不依赖消费者生成的 ORM client、表或业务模型；由消费者绑定现有模型、字段映射、事务和业务回调。既有原子更新、并发限制、幂等、权限和可恢复性必须保留，不用内存默认值或吞错来让接入通过。原语的独立测试不能替代消费者真实适配测试。
4. **按运行环境暴露接口。** 浏览器入口不应解析 Node 内置模块或原生 SDK；有副作用或可选重型依赖的服务端能力按明确入口加载。通过正确的 dependencies/peerDependencies、公开 exports 和消费者配置保持单一实例，不用打包副本或 `any` 掩盖兼容问题。
5. **明确完成边界。** 实现、公开导出、消费者调用与重复代码清理作为一组验证。发布按该包的交付契约和当前授权执行，固定版本/校验值再接入；不能把源码联调通过写成正式制品已交付。归属判断只需简短说明实际 API/文件依据，不要求普通功能新增设计文档、整仓抽取或无关依赖升级。

例：会话撤销与 Cookie 刷新属于认证机制；登录后发什么权益由应用决定。支付网关协议和账本原子操作属于机制；某种业务产物的价格与解锁条件属于应用。SVG/科学图形渲染可以由库实现；某国文书结构、页面文案和部署字体由消费者配置。

评审时检查是否出现产品规则泄漏、消费者反向依赖、重复公共机制或为接入而降低可靠性。构建、依赖与制品检查覆盖结构性错误；它们不能证明语义上不存在业务混入，不应以产品词汇黑名单替代调用链审查。

## 目录

- [新增能力的归属与接入](#新增能力的归属与接入)
- [分层架构](#分层架构)
- [核心设计模式](#核心设计模式)
- [模块依赖图](#模块依赖图)
- [横切关注点](#横切关注点)
- [弹性与容错](#弹性与容错)
- [安全架构](#安全架构)
- [开发者工具链](#开发者工具链)

---

## 分层架构

```
Layer 5: 模板应用 (templates/)
  ├── server (NestJS API)
  ├── admin  (React + Ant Design)
  └── web    (Next.js)

Layer 4: 高级能力
  ├── admin        自动 REST API 生成 + CrudControllerFactory
  ├── rule-engine  业务规则引擎
  ├── script       脚本执行沙箱
  ├── provider     Provider 注册表 + 健康检查
  ├── reference    数据引用管理
  └── monitoring   指标 + 告警 + UsageTracker

Layer 3: 基础设施
  ├── config       分层配置 + 热重载 + Feature Flags
  ├── cache        内存/Redis/混合缓存 + 标签化失效
  ├── storage      文件存储 (Local/S3/WebDAV)
  ├── notification  通知系统 + Webhook 可靠投递
  ├── queue        消息队列 + TaskLifecycleManager
  ├── credit       积分系统
  ├── tenant       多租户 (行级/Schema级/数据源级)
  ├── i18n         国际化
  └── ai           AI 集成

Layer 2: 框架核心
  ├── crud         BaseService + 动态查询 + 数据库适配器
  ├── auth         JWT + RBAC + 数据权限 + 2FA
  ├── event        实体事件 + 统一事件总线 + 操作 Hook
  └── logging      访问日志 + 结构化日志 + 审计日志 + PII 过滤

Layer 1: 基础
  ├── core         异常/类型/工具 + 断路器 + 流式管道 + 迁移框架 + VCR + Mailbox
  ├── common       请求上下文 + 全局过滤器/管道 + 优雅停机
  └── fe-types     前后端共享 Zod Schema
```

每一层只能依赖同层或更低层的模块。禁止反向依赖。

---

## 核心设计模式

### 1. 统一请求上下文 (RequestContext)

所有请求共享一个 `AsyncLocalStorage` 驱动的上下文，无需在每一层传递：

```ts
import { RequestContext } from '@zucker-framework/common';

// 中间件自动创建
// 任意 Service 中直接获取
const ctx = RequestContext.current();
ctx.correlationId;  // 请求追踪 ID
ctx.user;           // 认证用户
ctx.tenantId;       // 租户 ID
ctx.elapsed;        // 已用时间
```

### 2. 统一事件总线 (UnifiedEventBus)

合并本地事件和集群广播到一个接口：

```ts
import { UnifiedEventBus } from '@zucker-framework/event';

// 发布到本地 + 集群
await eventBus.publish('entity/user/create/after', { user });

// 仅本地（高频日志等）
await eventBus.publishLocal('access.log', payload);

// 订阅（支持 wildcard）
eventBus.subscribe('entity/user/**', handler);
```

### 3. 操作 Hook (OperationHookRegistry)

任意操作的前后注入点，不限于 CRUD：

```ts
import { OperationHookRegistry } from '@zucker-framework/event';

hooks.register('storage.upload', 'before', async (ctx) => {
  if (ctx.data.size > MAX_SIZE) ctx.cancel('文件过大');
});
```

### 4. 错误分类与自动重试

```ts
import { classifyError, withRetry, CircuitBreaker } from '@zucker-framework/core';

// 自动分类 Prisma 错误
const cls = classifyError(error);  // → { retryable, code, status }

// 带指数退避的自动重试
const result = await withRetry(() => api.call(), 3);

// 断路器保护外部服务
const breaker = new CircuitBreaker({ failureThreshold: 5 });
await breaker.execute(() => externalService.call());
```

### 5. 类型安全配置 + Feature Flag

```ts
import { defineConfig, mergeConfigs, loadFromEnv } from '@zucker-framework/core';
import { FeatureFlagService } from '@zucker-framework/config';

// Zod Schema 验证
const config = defineConfig({ port: z.number().default(3000) });

// Feature Flag 灰度
flags.register({
  key: 'new_dashboard',
  defaultValue: false,
  rules: [
    { type: 'allowlist', values: ['tenant-vip'] },
    { type: 'percentage', percentage: 20 },
  ],
});
```

### 6. 前后端共享 Schema

```ts
// @zucker-framework/fe-types — 一处定义，前后端共用
import { UserSchema, LoginRequestSchema } from '@zucker-framework/fe-types';

// 后端 DTO 验证
const user = UserSchema.parse(req.body);

// 前端表单验证
const result = LoginRequestSchema.safeParse(formValues);
```

---

## 模块依赖图

```
@zucker-framework/core ← 基础能力，不依赖 NestJS
    ↑
@zucker-framework/common ← NestJS 基础
@zucker-framework/event  ← NestJS + eventemitter2
    ↑
@zucker-framework/crud   ← core + event (可选)
@zucker-framework/auth   ← core + crud + passport
    ↑
其余模块按需依赖上述核心
```

关键约束：
- `@zucker-framework/core` 不依赖 NestJS（可在非 NestJS 环境使用）
- `@zucker-framework/fe-types` 不依赖 NestJS 或 Node 运行时；共享脱敏与 UA 机制只使用 Core 明确的浏览器安全入口（`core/privacy`、`core/user-agent`），不导入 Core 根入口。
- 所有包通过 `exports` 字段限制公开 API

---

## 横切关注点

### 缓存策略

| 层级 | 实现 | 用途 |
|------|------|------|
| L1 内存 | `MemoryCache` | 热点数据，最低延迟 |
| L2 Redis | `RedisCache` | 分布式，跨实例共享 |
| L1+L2 | `HybridCache` | 自动回填，两级协同 |
| 标签失效 | `TaggedCache` | 按业务维度批量清除 |

### 日志分层

| 类型 | 实现 | 用途 |
|------|------|------|
| 访问日志 | `AccessLoggerInterceptor` | HTTP 请求/响应记录 |
| 结构化日志 | `StructuredLogger` | JSON 格式，关联 traceId |
| 审计日志 | `AuditLogger` | 敏感操作不可变记录 |
| PII 过滤 | `PiiFilter` | 自动脱敏邮箱/手机/身份证 |

### 多租户隔离

| 策略 | 实现 | 适用场景 |
|------|------|---------|
| 行级隔离 | 自动注入 tenantId 过滤 | SaaS 共享数据库 |
| Schema 隔离 | 路由到 tenant_xxx schema | 中等隔离需求 |
| 数据源隔离 | 独立数据库连接 | 最高安全要求 |

---

## 弹性与容错

### 断路器 (CircuitBreaker)

```
CLOSED ──(连续失败达阈值)──→ OPEN ──(超时)──→ HALF_OPEN
  ↑                              ↑                  │
  └──(成功)──────────────────────┘    (失败)────────┘
```

### 重试策略

- `withRetry()`: 指数退避，仅对可重试错误（超时、连接、P2034 事务冲突）
- Webhook: 5xx 重试，4xx 不重试，最大 3 次
- 通知: 1s → 2s → 4s 退避，最大 30s

### 优雅停机

```
Phase 0: 停止接受新请求
Phase 1: 等待进行中的工作完成 (drain)
Phase 2: 刷新缓冲区 (flush logs/metrics)
Phase 3: 关闭连接 (DB/Redis/MQ)
Phase 9: 最终清理
```

---

## 安全架构

### 认证与授权

- JWT + Passport (可选 2FA TOTP)
- `@Permissions('user:query')` 声明式权限
- `@Resource('user') + @Action('query')` 资源-操作模型
- 四种数据访问控制: 仅创建者 / 字段过滤 / 范围 / 维度

### 输入安全

- `assertLegalColumn()`: 防止动态查询列名注入
- `PiiFilter`: 自动识别和脱敏 PII
- `ValidationPipe`: NestJS 全局参数校验
- Webhook HMAC-SHA256 签名验证

### 密钥管理

- `resolveJwtSecret()`: 非开发环境缺少配置直接报错
- 环境变量通过 `process.env` 注入，禁止硬编码
- ESLint `no-restricted-syntax` 检测硬编码 secret

---

## 开发者工具链

### CLI (`@zucker-framework/cli`)

```bash
zucker init my-app --template server  # 创建 Server 骨架
zucker add auth --dry-run              # 查看候选模块与配置提示
zucker --help                         # 查看当前版本支持的命令
```

新项目的版本选择、模板限制和 AI 指令落地见 [新项目指南](getting-started.md)；CLI 提示不代替公开 API 核对或业务验收。

### 测试工具

- **VCR 固件**: `withVcrFixture()` 录制/回放 API 响应
- **InMemoryAdapter**: 零数据库依赖的单元测试
- **InMemoryAuditStore**: 审计日志测试替身

### 配置热重载

```ts
import { ConfigFileWatcher } from '@zucker-framework/config';

const watcher = new ConfigFileWatcher();
watcher.watch('/path/to/config.json', () => {
  configService.clearCache();
});
```

### 流式处理管道

```ts
import { mapStream, batchStream, collectStream } from '@zucker-framework/core';

const pipeline = batchStream(
  mapStream(dataSource, item => transform(item)),
  100,
);
for await (const batch of pipeline) {
  await bulkInsert(batch);
}
```

---

## 包清单

| 包 | 描述 | 层级 |
|----|------|------|
| `@zucker-framework/core` | 异常、类型、断路器、流式管道、VCR、Mailbox、迁移 | L1 |
| `@zucker-framework/common` | 请求上下文、全局过滤器/管道、优雅停机 | L1 |
| `@zucker-framework/fe-types` | 前后端共享 Zod Schema | L1 |
| `@zucker-framework/event` | 实体事件、统一事件总线、操作 Hook | L2 |
| `@zucker-framework/crud` | BaseService、动态查询、CRUD 装饰器 | L2 |
| `@zucker-framework/auth` | JWT、RBAC、数据权限、2FA | L2 |
| `@zucker-framework/logging` | 访问日志、结构化日志、审计日志、PII 过滤 | L2 |
| `@zucker-framework/config` | 分层配置、热重载、Feature Flag | L3 |
| `@zucker-framework/cache` | 内存/Redis/混合缓存、标签化失效 | L3 |
| `@zucker-framework/notification` | 多渠道通知、Webhook 注册与投递 | L3 |
| `@zucker-framework/queue` | 消息队列、TaskLifecycleManager | L3 |
| `@zucker-framework/monitoring` | 指标、告警、UsageTracker | L4 |
| `@zucker-framework/provider` | Provider 注册表、健康检查 | L4 |
| `@zucker-framework/admin` | 自动 REST API 生成 | L4 |
| `@zucker-framework/cli` | 脚手架、诊断、模块管理 | 工具 |
