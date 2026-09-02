# AGENTS.md — Zucker Framework AI 使用手册

> 这份文档是给 AI 助手（Claude / Cursor / Copilot）看的。**目标：让你不用扫描整个 monorepo 就能在 zucker 上写代码。**
>
> 与 `CLAUDE.md` 的分工：CLAUDE.md 讲项目背景和约定；本文档讲「想做某件事用哪个包、怎么用」。
>
> **外部文档**：NestJS / Prisma / React 等原生 API 不在本文档范围内，直接调
> Context7 MCP（`/nestjs/docs.nestjs.com`、`/prisma/docs`、`/reactjs/react.dev`），
> 比扫官方文档站快 10×。本文档只覆盖 zucker 在这些基础库之上叠加的能力。

## 一、最重要的两条规则

1. **想做某事之前先查这份文档的"决策树"小节。** 大多数能力 zucker 已经实现，复制业务侧 boilerplate 是最常见的反模式。
2. **不要 import `packages/*/src/...` 内部路径。** 只能 `import { X } from '@zucker/<pkg>'`（barrel exports 已经过 `package.json#exports` 锁住）。

## 二、技术栈速查（不要假设、不要换）

| 项       | 值                                                    |
| -------- | ----------------------------------------------------- |
| 后端     | NestJS 11                                             |
| ORM      | Prisma 6（业务侧 schema 命名 PascalCase）             |
| 前端     | React 19 + Ant Design 5（admin） / Next.js（landing） |
| 验证     | Zod v4                                                |
| 测试     | Vitest（单元） + Playwright（E2E）                    |
| 包管理   | pnpm 9.x workspace                                    |
| 模块导出 | tsup → CJS + ESM + .d.ts                              |

## 三、决策树 — "我想做 X" 索引

### A. 后端基础设施

| 我想做…                                                             | 用               | 关键 API（签名/示例）                                                                 |
| ------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------- |
| 给 NestJS 服务建 AsyncLocalStorage 上下文（agent 编排 / batch job） | `@zucker/core`   | `createScopedContext<T>('name')` → `{ run, current, required, pick }`                 |
| HTTP 请求级元数据（locale / correlationId / tenantId）              | `@zucker/common` | `RequestContext.required()`（已是 @Global module）                                    |
| 类型安全配置 + 环境变量 + 分层合并                                  | `@zucker/config` | `TypedConfig.fromZod(schema, { envPrefix })`                                          |
| 把 PrismaService 注入成 framework 的 DATABASE_ADAPTER               | `@zucker/crud`   | `PrismaDatabaseAdapterModule.forRoot({ prismaService, prismaModule, modelAliases? })` |
| 跨切关注点的 hook 注册（before/after action）                       | `@zucker/core`   | `OperationHookRegistry`                                                               |
| 三态断路器 / 自动重试                                               | `@zucker/core`   | `CircuitBreaker`、`withRetry()`、`ErrorClassifier`                                    |
| 优雅停机（按阶段 drain）                                            | `@zucker/core`   | `GracefulShutdownManager`                                                             |
| 通用 CRUD controller（声明式生成路由）                              | `@zucker/crud`   | `CrudControllerFactory.create({ entity, service, routes })`                           |

### B. 数据访问

| 我想做…                                                    | 用             | 关键 API                                                                |
| ---------------------------------------------------------- | -------------- | ----------------------------------------------------------------------- |
| Prisma 抽象（动态 model lookup）                           | `@zucker/crud` | `PrismaAdapter`（自动 PascalCase acronym 别名：`aiModels` → `aIModel`） |
| 不依赖 Prisma 跑测试                                       | `@zucker/crud` | `InMemoryAdapter` 实现同 `DatabaseAdapter` 接口                         |
| 动态查询解析（`{ field, op, value }` JSON → Prisma where） | `@zucker/crud` | `DynamicQueryService.parse()`                                           |
| 树形结构 service / controller                              | `@zucker/crud` | `TreeService` / `TreeController`                                        |
| 软删除                                                     | `@zucker/crud` | `SoftDeleteService` + `SoftDeletableEntity`                             |

### C. AI / LLM 调用

| 我想做…                                                     | 用           | 关键 API                                                                                                |
| ----------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------- |
| 调用 LLM（OpenAI / Claude / Gemini / DeepSeek）             | `@zucker/ai` | `AICallWrapper.callWithRetry(fn, { context, timeoutMs, maxAttempts })`                                  |
| 流式调用（聚合后返回完整 content）                          | `@zucker/ai` | `AICallWrapper.callWithStream(fn, openAIStreamExtractor, opts)`                                         |
| 按场景动态加载模型配置（env / API / DB / 静态）             | `@zucker/ai` | `AIConfigService.getScenarioConfig(scenario)` + `EnvironmentAIConfigSource` / `RemoteAIConfigSource` / `DatabaseAIConfigSource` |
| 注册 Provider                                               | `@zucker/ai` | `AIProviderManager.register(new OpenAIProvider())` 等 4 个内置                                          |
| 管理 Provider 认证与 PostgreSQL Profile                    | `@zucker/ai-access` | `AIAccessProviderRegistry` + `PostgresCredentialProfileStore`                                          |
| 在可信内部任务中使用 Codex 订阅                            | `@zucker/ai-access` | `OpenAICodexCliSubscriptionProvider`（官方 CLI，默认）；直连 Responses 仅为实验兼容路径                  |
| 把 AI 调用日志写入业务 OperationLog 表                      | `@zucker/ai` | `PrismaOperationLogObserver`（提供 `OperationLogSink` 即可）                                            |
| 持久化 AI 成本统计（按 5 分钟周期聚合）                     | `@zucker/ai` | `extends PersistedCostTracker`，提供 `CostPersister` 实现                                               |
| 把不同 AI 调用结果归一化（chat / stream / embedding）       | `@zucker/ai` | `summarizeAIResult(result, { previewMax })`                                                             |
| 装饰器追踪 AI 用量                                          | `@zucker/ai` | `@TrackAIUsage({ scenario })`                                                                           |
| Prompt 模板动态加载 + 变量替换                              | `@zucker/ai` | `PromptManager.findByKey(key)` + `template(vars)`                                                       |
| 跨 Provider 协商 JSON / JSON Schema 输出                    | `@zucker/ai` | `adaptResponseFormat(provider, format, schema)` + `PROVIDER_CAPABILITIES`                               |
| 媒体生成（DALL-E / Replicate / Runway / Kling / Stability） | `@zucker/ai` | `MediaGenerationService.generate({ type, provider })`                                                   |

### D. 认证 / 权限

| 我想做…                         | 用                                | 关键 API                                             |
| ------------------------------- | --------------------------------- | ---------------------------------------------------- |
| JWT 登录 + refresh token        | `@zucker/auth`                    | `AuthModule.forRoot()`，`@LoginRequired()` decorator |
| 权限装饰器                      | `@zucker/auth`                    | `@RequirePermissions('module:action')`               |
| 数据权限（按 user/tenant 过滤） | `@zucker/auth` + `@zucker/tenant` | `@DataPermission('Entity')`                          |
| OAuth2（GitHub / Google）       | `@zucker/auth`                    | `OAuth2Module.forRoot({ providers: [...] })`         |
| 多租户                          | `@zucker/tenant`                  | `TenantContext.required()` 拿当前 tenant             |

### E. 缓存 / 任务 / 消息

| 我想做…                              | 用                     | 关键 API                                           |
| ------------------------------------ | ---------------------- | -------------------------------------------------- |
| 通用缓存（内存 / Redis）             | `@zucker/cache`        | `CacheManager.wrap(key, factory, ttl)`             |
| 标签化失效                           | `@zucker/cache`        | `TaggedCache.invalidate(tag)`                      |
| 持久化任务状态机 + 幂等 + lease 契约 | `@zucker/task`         | `TaskRepository`、`assertTaskTransition()`         |
| 队列传输与本地开发队列               | `@zucker/queue`        | `QueueProvider`、`InMemoryQueue`                   |
| 本地 + 集群事件总线                  | `@zucker/event`        | `UnifiedEventBus.publish(event)` / `@OnEvent('x')` |
| Webhook 投递（HMAC + 重试 + 追踪）   | `@zucker/notification` | `WebhookRegistry.send({ url, payload, secret })`   |
| Actor 模式消息路由                   | `@zucker/cluster`      | `Mailbox.send(actorId, msg)`                       |

### F. 横切观测

| 我想做…                                           | 用                     | 关键 API                                                                                                                                                        |
| ------------------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 结构化日志                                        | `@zucker/logging`      | `Logger.child({ module })`，自动 PII 脱敏                                                                                                                       |
| 追加式操作审计                                    | `@zucker/logging`      | `AuditLogger.log(...)` 为兼容型 best effort；必须阻断业务的安全事件使用 `logRequired(...)`；生产不可变性、持久化、事务绑定和 retention 由业务 `AuditStore` 保证 |
| 链路追踪                                          | `@zucker/tracing`      | `@Trace()` decorator，OpenTelemetry 兼容                                                                                                                        |
| Feature Flag（4 层：env / DB / user / rollout %） | `@zucker/config`       | `FeatureFlagService.isEnabled(flag, ctx)`                                                                                                                       |
| Rate limit                                        | `@zucker/rate-limiter` | `RateLimiterGuard({ points, duration })`                                                                                                                        |
| 监控指标（Prometheus）                            | `@zucker/monitoring`   | `@Metric.counter('name')`                                                                                                                                       |
| PII 自动识别脱敏                                  | `@zucker/logging`      | `PiiFilter.scrub(obj)`                                                                                                                                          |

### G. 前端（React / Next）

| 我想做…                                   | 用                       | 关键 API                                                                      |
| ----------------------------------------- | ------------------------ | ----------------------------------------------------------------------------- |
| HTTP 请求与 SSE 流                        | `@zucker/fe-http-client` | `httpClient.get<T>(url)` / `connectSse()` / `readSseStream()`                 |
| 表单（schema-driven）                     | `@zucker/fe-form`        | `<ZForm schema={...} onSubmit={...} />`                                       |
| 权限渲染                                  | `@zucker/fe-permission`  | `<RequirePermission code="x">`                                                |
| 本地存储                                  | `@zucker/fe-storage`     | `LocalStore.setToken(t)` / `getToken()`                                       |
| 图片 MIME/base64/data URI 与 SVG 安全策略 | `@zucker/media`          | `detectImageMimeFromBytes()` / `resolveImageSource()` / `sanitizeSvgMarkup()` |
| 共享类型（前后端）                        | `@zucker/fe-types`       | `import type { ApiResponse<T> }`                                              |
| 登录组件                                  | `@zucker/fe-auth`        | `<LoginForm onSuccess={...} />`                                               |
| 分析事件                                  | `@zucker/fe-analytics`   | `track('event', { props })`                                                   |

### H. CLI / 脚手架

| 我想做…          | 用            | 命令                   |
| ---------------- | ------------- | ---------------------- |
| 新建 zucker 项目 | `@zucker/cli` | `npx @zucker/cli init` |
| 诊断环境         | `@zucker/cli` | `zucker doctor`        |
| 添加模块         | `@zucker/cli` | `zucker add <module>`  |
| 管理 AI Profile  | `@zucker/cli` | `zucker ai store init/login/status/profile import/smoke` |

## 四、绝不要做（反模式清单）

| ❌ 不要                                          | ✅ 应该                                                       |
| ------------------------------------------------ | ------------------------------------------------------------- |
| 自己写 AsyncLocalStorage 模板（60 行）           | `createScopedContext<T>('name')`                              |
| 业务侧自建 PrismaAdapter + DatabaseAdapterModule | `PrismaDatabaseAdapterModule.forRoot(...)`                    |
| 自己写 100 行 AICallObserver                     | `extends PrismaOperationLogObserver` + sink adapter           |
| 自己写成本聚合 + Cron flush                      | `extends PersistedCostTracker` + `CostPersister`              |
| 在库包里 `process.env.X`                         | `ConfigService.get(...)` 或 `TypedConfig`                     |
| Controller 手动包装 `{success, data}`            | `TransformInterceptor` 全局已注册，直接 `return data`         |
| 手动 `try { ... } catch { throw err }`           | 让框架的 `ErrorClassifier` / `withRetry` 处理                 |
| 在前端写 `request.ts` 封装 fetch                 | `@zucker/fe-http-client` 已经有                               |
| `@zucker/core` 加 NestJS 依赖                    | core 必须保持纯 TypeScript（fe-types 同理：不依赖任何后端包） |

## 五、最小可行项目骨架

新 zucker 项目要跑起 AI 调用 + dossier 风格 agent 编排，最少需要：

```ts
// app.module.ts
@Module({
  imports: [
    PrismaModule, // 你自己的 Prisma 模块
    PrismaDatabaseAdapterModule.forRoot({
      prismaService: PrismaService,
      prismaModule: PrismaModule,
      modelAliases: { aiModels: 'aIModel' }, // 仅当 schema 有 acronym 时
    }),
    ZuckerAIModule.forRoot(), // 注册 AIConfigService / AICallWrapper / ...
    AuthModule.forRoot({ jwtSecret: cfg.jwt.secret }),
  ],
})
export class AppModule {}
```

不使用数据库时，直接配置环境变量源：

```ts
import { EnvironmentAIConfigSource, ZuckerAIModule } from '@zucker/ai';

ZuckerAIModule.forRoot({
  configSources: [
    new EnvironmentAIConfigSource({ env: process.env }),
  ],
});
```

配置源按 `priority` 从高到低匹配，首个返回配置的来源生效。默认优先级为：环境变量 `300`、远程 API `200`、数据库/静态配置 `100`。基础包不直接读取 `process.env`，业务侧负责加载 `.env` 后传入。

```ts
// my-agent.context.ts
import { createScopedContext } from '@zucker/core';

interface MyContext {
  taskId: string;
  userId: string;
}
export const MyContext = createScopedContext<MyContext>('my-agent');
```

```ts
// 调 LLM
const completion = await wrapper.callWithRetry(
  () => openai.chat.completions.create({ model, messages }),
  { context: 'my-scenario', timeoutMs: 180_000, maxAttempts: 3 },
);
```

## 六、看哪些测试就懂了

不会用某个 API 时，**先读测试**而不是源码。每个 API 都有 `.spec.ts` 同目录：

| 想学                                   | 读                                             |
| -------------------------------------- | ---------------------------------------------- |
| ScopedContext                          | `packages/core/src/scoped-context.spec.ts`     |
| PrismaAdapter                          | `packages/crud/src/prisma-adapter.spec.ts`     |
| AICallObserver                         | `packages/ai/src/observers/observers.spec.ts`  |
| AICallWrapper                          | `packages/ai/src/call-wrapper.spec.ts`         |
| AI 多配置源                            | `packages/ai/src/config-sources/config-sources.spec.ts` |
| AI Access 与 Codex Provider            | `packages/ai-access/src/*.spec.ts` |
| TypedConfig                            | `packages/config/src/typed-config.spec.ts`     |
| EventBus                               | `packages/event/src/unified-event-bus.spec.ts` |
| 持久化任务状态机与 fencing             | `packages/task/src/*.spec.ts`                  |
| CrudController                         | `packages/crud/src/base.controller.spec.ts`    |
| InMemoryAdapter（写 service 单测必用） | `packages/crud/src/in-memory-adapter.spec.ts`  |

## 七、如何添加新能力到框架（反哺路径）

业务项目里发现重复的 boilerplate，应反哺到框架：

1. **看现状** — `@zucker/<相关包>` 是否已有类似抽象（grep + 读测试）
2. **设计接口** — sink/persister 风格（业务实现接口，框架做编排），不绑定具体 schema
3. **写实现 + spec** — 至少 5 个 case 覆盖：happy path / nested / 失败 / 边界 / 选项
4. **在 packages/<pkg>/src/index.ts 加 export**
5. **用法文档加进本 AGENTS.md 的决策树**
6. **业务侧做 migration**（删旧代码 → 验证 typecheck → 跑一次端到端）

参考 `zucker-ccopyright/docs/v2/framework-reciprocal-plan.md` 的 PR 范式。

## 八、特别提示

- **JWT_SECRET** 在非开发环境**必须显式设置**，否则启动报错（防默认值泄漏）
- **`@zucker/core` 不依赖 NestJS** — 加新东西如果想用 `@Injectable()`，应该放 `@zucker/common` 或具体 domain 包
- **prompt cache TTL 5 分钟** — AI 调用相关 schema 改动后调用 `aiConfig.invalidateScenario(scenario)` 让缓存失效
- **Cron 装饰器**（`@nestjs/schedule`）由业务侧使用，框架不直接依赖。如 `PersistedCostTracker.flush()` 由业务侧 `@Cron('*/5 * * * *')` 包装
