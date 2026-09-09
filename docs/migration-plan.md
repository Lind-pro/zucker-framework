# zucker-framework 全量迁移方案（方案 A）

## Context

决策依据：
- MVP 跑通后修补基础设施的代价远大于提前建设
- 决定全面转向 Node.js/TypeScript，不再用 Java 技术栈
- 未来各类业务项目都通过公开包接口使用 zucker-framework

实现来源与参考：
- **jetlinks-community** — 移植通用基础设施模式（ConfigManager、Provider SPI、EventBus、通知、规则引擎等）
- **既有消费项目** — 已验证的 NestJS 实现直接复制
- **ShipAny 模板** — 借鉴 ProviderManager 模式、积分系统、多数据库抽象

---

## 完整包清单（27 个后端包 + 6 个前端包）

### 第一层：核心基础（零/极少依赖）

| 包 | 能力或参考 | 来源 | 说明 |
|---|---|---|---|
| `@zucker-framework/core` | 核心基础能力 | 新建+既有消费项目 | DatabaseAdapter 接口、实体基类层级(Generic→RecordCreation→TreeSort)、ID 生成器(Snowflake/UUID/CUID)、异常层级(Business/Validation/NotFound/I18n)、ApiResponse/PaginatedResult/QueryParam 类型、Diff(对象变更追踪)、TemplateParser(变量替换)、验证分组(Create/Update Group) |
| `@zucker-framework/common` | 应用启动与请求处理 | 既有消费项目 复制 | TransformInterceptor、HttpExceptionFilter、RequestLoggerMiddleware、TrimStringPipe |
| `@zucker-framework/event` | 实体生命周期事件与主题事件总线 | 新建 | 实体生命周期事件(Prepare→Before→After 三阶段，覆盖 create/update/delete/query)、内置监听器(Validate/Creator/Composite)、TopicEventBus(EventEmitter2 通配符 /a/\*/b/\*\*)、AsyncEvent |

### 第二层：框架核心（依赖第一层）

| 包 | 能力或参考 | 来源 | 说明 |
|---|---|---|---|
| `@zucker-framework/crud` | 通用 CRUD 与动态查询 | 既有消费项目 重构 | BaseService\<T\>(用 DatabaseAdapter)、BaseController 工厂、TreeSortEntityService(树形 CRUD)、动态查询引擎(14+ operators)、TermExpressionParser(WHERE 表达式解析)、FilterMap 语法({"field$op":"value"})、并行分页(count+fetch 并发，total 复用)、PrismaAdapter 参考实现 |
| `@zucker-framework/auth` | 认证、授权与维度权限 | 既有消费项目 重构+新增 | JWT/Local/OAuth2 策略基类、Guards(JWT/Permissions/DataPermission/Subscription)、Decorators(@Permissions/@Resource/@Action/@Public/@CurrentUser/@DataPermission)、PermissionService+Scanner+角色层级展开、维度权限(DimensionProvider 接口+DimensionService+用户绑定)、Token 状态机(normal/expired/lock/deny/offline)、OAuth2 客户端管理、第三方账号绑定、菜单权限管理 |
| `@zucker-framework/logging` | 访问日志与操作审计 | 既有消费项目 重构 | @AccessLogger 装饰器、AccessLoggerInterceptor(事件驱动)、OperationLogService、AccessLogBefore/AfterEvent |

### 第三层：基础设施服务（依赖第一二层）

| 包 | 能力或参考 | 来源 | 说明 |
|---|---|---|---|
| `@zucker-framework/config` | jetlinks ConfigManager | 新建 | ConfigScope+ConfigPropertyDef、ConfigService(DB CRUD+缓存+Zod 校验)、@ConfigScope() 装饰器、热加载(配置变更事件)、环境变量 fallback |
| `@zucker-framework/dictionary` | 字典与字典项管理 | 新建 | DictionaryService(字典 CRUD)、DictionaryItemService(树形字典项)、@DictField() 装饰器、位掩码多选、字典缓存+ClearDictionaryCacheEvent |
| `@zucker-framework/cache` | 多级缓存与失效策略 | 既有消费项目 重构 | ICache\<T\> 接口(get/set/evict/clear)、MemoryCache(LRU)、RedisCache、HybridCache(二级：本地+Redis)、缓存失效策略(TTL/手动/级联) |
| `@zucker-framework/rate-limiter` | 无 (既有消费项目 独有) | 既有消费项目 复制 | forRoot() 配置化、声明式限流器注册、Redis+内存 provider |
| `@zucker-framework/storage` | 文件管理与存储适配 | 既有消费项目 重构 | FileManager 接口(save/read/delete+Hash 校验 MD5/SHA256)、LocalStorage、S3Storage、WebDAVStorage |
| `@zucker-framework/notification` | jetlinks notify-component + notify-manager | 既有消费项目 邮件+新建 | NotifierProvider 接口+通道工厂、内置 Provider(Email-SMTP/Resend, SMS-阿里云, WeChat, DingTalk, Webhook)、模板引擎+变量源解析(fixed/upper/relation)、订阅者管理+多通道分发、发送历史 |
| `@zucker-framework/credit` | ShipAny credit 系统 | 新建 | CreditService(充值/消费/退款)、积分过期管理、余额查询、事务历史、订阅关联 |
| `@zucker-framework/ai` | 无 (既有消费项目 独有 + ShipAny ProviderManager) | 既有消费项目 重构 | LangChain 模型工厂(多供应商)、ProviderManager 模式(注册/切换 AI Provider)、DB 场景化配置、重试+超时+日志、结构化输出(Zod schema)、SSE 流式响应助手、成本追踪(事件驱动) |

### 第四层：高级能力（依赖第三层）

| 包 | 能力或参考 | 来源 | 说明 |
|---|---|---|---|
| `@zucker-framework/provider` | jetlinks SPI + Strategy | 新建 | Provider\<T\> 注册中心、StrategyManager\<S\>(可插拔策略)、生命周期 Hook(注册/注销回调) |
| `@zucker-framework/reference` | jetlinks DataReferenceManager | 新建 | 引用检查+删除保护、@PreventDeleteIfReferenced() 装饰器 |
| `@zucker-framework/script` | jetlinks script-component | 新建 | ScriptFactory(编译+执行 JS)、安全沙箱(isolated-vm)、ExposedScript(暴露 TS 方法给脚本)、接口绑定 |
| `@zucker-framework/rule-engine` | jetlinks rule-engine-component | 新建 | 条件 DSL(terms/expression/script 三种)、动作执行器(通知/HTTP/脚本/SQL)、触发器(事件/定时器/手动)、规则 CRUD+执行引擎、告警管理(AlarmConfig+AlarmRecord) |
| `@zucker-framework/monitoring` | 既有消费项目 monitoring | 既有消费项目 复制 | 错误追踪(分类+聚合+告警)、健康检查、Dashboard 指标(可插拔 MeasurementProvider) |

### 第五层：分布式（依赖第四层）

| 包 | 能力或参考 | 来源 | 说明 |
|---|---|---|---|
| `@zucker-framework/cluster` | jetlinks configure-component | 新建 | ClusterManager(Redis 节点注册+心跳)、DistributedLock(Redis SETNX)、DistributedEventBus(Redis pub/sub 扩展 TopicEventBus) |

### 第六层：IoT 专用（jetlinks 移植，最后做）

| 包 | 能力或参考 | 来源 | 说明 |
|---|---|---|---|
| `@zucker-framework/things` | jetlinks things-component | 新建 | 物模型(Type→Instance)、属性/事件/日志存储、MetricMetadataManager |
| `@zucker-framework/gateway` | jetlinks gateway+network | 新建 | 协议网关(MQTT/TCP/CoAP/HTTP/WebSocket)、Protocol codec 接口、Session 管理、连接生命周期 |
| `@zucker-framework/timeseries` | jetlinks timeseries | 新建 | 时序数据抽象、可插拔后端(TimescaleDB/ES/TDengine)、TimeSeriesService |
| `@zucker-framework/network` | jetlinks network-component | 新建 | 网络配置管理、证书管理、Transport 抽象 |

### 前端包

| 包 | 来源 | 说明 |
|---|---|---|
| `@zucker-framework/fe-http-client` | 既有消费项目 packages/http-client | Axios 封装、Token 刷新队列、响应解包、SSE 流 |
| `@zucker-framework/fe-storage` | 既有消费项目 packages/storage | localStorage 抽象 |
| `@zucker-framework/fe-auth` | 既有消费项目 packages/auth | Zustand 认证 store |
| `@zucker-framework/fe-permission` | 既有消费项目 packages/permission | 权限 hooks + Guard 组件 |
| `@zucker-framework/fe-analytics` | 既有消费项目 analytics.ts | 埋点工具 |
| `@zucker-framework/fe-types` | 既有消费项目 packages/types | 共享类型 |

---

## 依赖图

```
Layer 1: @zucker-framework/core  @zucker-framework/common  @zucker-framework/event
              │
Layer 2: @zucker-framework/crud ──── @zucker-framework/auth ──── @zucker-framework/logging
              │                  │
Layer 3: @zucker-framework/config    @zucker-framework/cache      @zucker-framework/notification
         @zucker-framework/dictionary @zucker-framework/storage   @zucker-framework/credit
         @zucker-framework/rate-limiter @zucker-framework/ai
              │
Layer 4: @zucker-framework/provider  @zucker-framework/reference  @zucker-framework/script
         @zucker-framework/rule-engine @zucker-framework/monitoring
              │
Layer 5: @zucker-framework/cluster
              │
Layer 6: @zucker-framework/things  @zucker-framework/gateway  @zucker-framework/timeseries  @zucker-framework/network
```

---

## 分阶段实施

### Phase 0: 仓库骨架（1 周）

- 创建 `zucker-framework` 仓库
- pnpm workspace + turborepo + tsup + changeset
- ESLint + Prettier + tsconfig 共享配置
- GitHub Actions: lint + build + publish
- 所有包的空壳 package.json + 入口文件

### Phase 1: Layer 1-2 核心（4 周）

**@zucker-framework/core（1 周）：**
- DatabaseAdapter 接口 + PrismaAdapter 参考实现
- 实体基类：GenericEntity → RecordCreationEntity → TreeSortSupportEntity
- ID 生成器：Snowflake, UUID, CUID
- 异常层级：BusinessException, ValidationException, NotFoundException, I18nSupportException
- 类型：ApiResponse, PaginatedResult, QueryParam
- Diff 工具（对象变更追踪）
- TemplateParser（变量替换 `${var}`）
- 验证分组 CreateGroup / UpdateGroup

**@zucker-framework/event（1 周）：**
- 实体生命周期事件（基于 @nestjs/event-emitter）
  - EntityPrepareCreateEvent（可修改实体数据）
  - EntityBeforeCreateEvent（可取消操作）
  - EntityCreatedEvent（只读通知）
  - 同样覆盖 Update、Delete、Query
- 内置监听器：ValidateEventListener、CreatorEventListener
- CompositeEventListener（链式组合）
- TopicEventBus（EventEmitter2 通配符支持）

**@zucker-framework/common（2 天）：**
- 从 既有消费项目 直接复制 TransformInterceptor、HttpExceptionFilter、RequestLoggerMiddleware、TrimStringPipe

**@zucker-framework/crud（1 周）：**
- BaseService\<T\>（从 既有消费项目 复制，重构为 DatabaseAdapter）
- BaseController 工厂函数
- TreeSortEntityService（树形 CRUD）
- 动态查询：14 operators 从 既有消费项目 复制
- 新增 TermExpressionParser：`"name = '张三' and age > 16"` → 结构化 terms
- 新增 FilterMap 解析：`{"name$like":"张三"}` → 结构化 terms
- 并行分页：count + fetch 并发执行，total 复用
- BaseService 自动发射实体事件（集成 @zucker-framework/event）

**@zucker-framework/auth（1.5 周）：**
- 从 既有消费项目 复制全部 guards、decorators、strategies、services
- 重构 PermissionService 使用 DatabaseAdapter
- 新增角色层级展开（RoleHierarchyService）
- 新增维度权限（DimensionProvider 接口 + DimensionService）
- 新增 Token 状态机
- 新增 OAuth2 客户端管理
- 新增第三方账号绑定
- 新增菜单权限管理

**@zucker-framework/logging（3 天）：**
- 从 既有消费项目 复制 @AccessLogger + 拦截器
- 重构为事件驱动（emit hsnode.access-log / hsnode.operation-log）
- 新增 AccessLogBefore/AfterEvent

### Phase 2: Layer 3 基础设施（4 周）

**@zucker-framework/config（3 天）：**
- ConfigScope + ConfigPropertyDef 定义
- ConfigService：DB CRUD + 内存缓存 + Zod 校验 + 变更事件
- @ConfigScope() 装饰器
- forRoot() 注册 scope 和默认属性

**@zucker-framework/dictionary（4 天）：**
- DictionaryService + DictionaryItemService（树形）
- @DictField() 字段装饰器
- 位掩码多选编码
- 字典缓存 + 失效事件

**@zucker-framework/cache（3 天）：**
- ICache\<T\> 接口
- MemoryCache（node-cache/LRU）
- RedisCache
- HybridCache（二级缓存）

**@zucker-framework/rate-limiter（2 天）：**
- 从 既有消费项目 复制 + forRoot() 配置化

**@zucker-framework/storage（3 天）：**
- FileManager 接口 + Hash 校验
- LocalStorage, S3Storage, WebDAVStorage

**@zucker-framework/notification（5 天）：**
- NotifierProvider 接口 + 通道工厂
- 内置：Email(SMTP/Resend), SMS(阿里云), WeChat, DingTalk, Webhook
- 模板引擎 + VariableSource 解析
- 订阅者管理 + 分发 + 历史

**@zucker-framework/credit（3 天）：**
- CreditService（grant/consume/refund/query）
- 积分过期检查（Cron）
- 事务历史
- 订阅自动充值

**@zucker-framework/ai（4 天）：**
- 从 既有消费项目 复制 + 重构
- ProviderManager（注册/获取/切换 AI Provider）
- DB 场景配置（用 DatabaseAdapter）
- 结构化输出 + 流式响应
- 成本追踪事件

### Phase 3: Layer 4 高级能力（3 周）

**@zucker-framework/provider（2 天）：**
- Provider\<T\> 注册中心 + Hook
- StrategyManager\<S\>

**@zucker-framework/reference（2 天）：**
- DataReferenceManager + @PreventDeleteIfReferenced()

**@zucker-framework/script（4 天）：**
- ScriptFactory（编译 JS）
- 沙箱（isolated-vm 或 vm2）
- ExposedScript + 接口绑定

**@zucker-framework/rule-engine（6 天）：**
- 条件评估（TermsCondition, ExpressionCondition, ScriptCondition）
- 动作执行器（NotifyAction, HttpAction, ScriptAction, SqlAction）
- 触发器（EventTrigger, TimerTrigger, ManualTrigger）
- 规则实例 CRUD + 执行引擎

**@zucker-framework/monitoring（3 天）：**
- 从 既有消费项目 复制 + 增强
- MeasurementProvider 可插拔指标

### Phase 4: Layer 5 + 模板 + 文档（3 周）

**@zucker-framework/cluster（4 天）：**
- ClusterManager（Redis 节点注册 + 心跳）
- DistributedLock
- DistributedEventBus

**前端包（3 天）：**
- 从 既有消费项目 packages/ 复制 + 重命名
- @zucker-framework/fe-http-client, fe-storage, fe-auth, fe-permission, fe-analytics, fe-types

**templates/（5 天）：**
- `templates/server/`：NestJS AppModule 接入所有后端 @zucker-framework 包，含示例业务模块
- `templates/admin/`：Ant Design 后台，含用户/角色/权限/字典/菜单/配置/积分管理页面
- `templates/web/`：Next.js 前台，i18n + SEO + 认证 + 埋点

**prisma-schemas/（2 天）：**
- auth.prisma（users, roles, permissions, dimensions, tokens, oauthClients, thirdPartyBinds, menus）
- logging.prisma（accessLogs, operationLogs）
- dictionary.prisma（dictionaries, dictionaryItems）
- config.prisma（configScopes, configProperties）
- notification.prisma（notifyTemplates, notifySubscribers, notifyChannels, notifyHistory）
- credit.prisma（credits, creditTransactions）
- rule-engine.prisma（rules, ruleConditions, ruleActions, alarmConfigs, alarmRecords）

**文档（3 天）：**
- Getting Started
- 模块扩展指南（"如何添加新业务模块"）
- API Reference（每个包的核心接口）
- jetlinks 移植路线图

### Phase 5: Layer 6 IoT（未来，jetlinks 移植启动时）

- @zucker-framework/things
- @zucker-framework/gateway
- @zucker-framework/timeseries
- @zucker-framework/network

---

## 关键架构决策

### 1. DatabaseAdapter（最核心）
所有包通过接口操作数据库，不依赖 @prisma/client。消费项目提供 PrismaAdapter。

### 2. 事件驱动解耦
AccessLogger、实体事件、成本追踪、缓存失效、配置变更等全部通过 EventEmitter 解耦。

### 3. forRoot() 配置
所有 Module 使用 `HsModule.forRoot(options)` / `forRootAsync()` 注入配置。

### 4. ProviderManager 模式（借鉴 ShipAny + jetlinks）
AI、通知、存储等服务统一使用 Provider 注册模式，运行时可切换实现。

### 5. npm 包发布（Maven 模式）
Changesets 管理版本，GitHub Actions 自动发布。下游项目通过版本号依赖。开发阶段 pnpm link 联调。

---

## 时间线总览

| 阶段 | 内容 | 工期 |
|------|------|------|
| Phase 0 | 仓库骨架 | 1 周 |
| Phase 1 | Layer 1-2 核心 (core/event/common/crud/auth/logging) | 4 周 |
| Phase 2 | Layer 3 基础设施 (config/dict/cache/limiter/storage/notify/credit/ai) | 4 周 |
| Phase 3 | Layer 4 高级能力 (provider/reference/script/rule-engine/monitoring) | 3 周 |
| Phase 4 | Layer 5 + 前端包 + 模板 + schema + 文档 | 3 周 |
| Phase 5 | Layer 6 IoT (things/gateway/timeseries/network) | 待定 |
| **总计** | **Phase 0-4** | **~15 周** |

---

## 验证方式

1. **Phase 0**: `pnpm build` 所有包编译通过
2. **Phase 1**: demo 项目：注册→登录→CRUD→权限→数据权限→树形操作→实体事件→动态查询表达式
3. **Phase 2**: demo 项目：运行时改配置→字典下拉→多通道通知→AI 生成→积分扣减→文件上传
4. **Phase 3**: demo 项目：规则引擎执行条件→动作→告警、脚本沙箱执行、引用删除保护
5. **Phase 4**: `npx create-zucker-app` 创建全新项目，所有功能开箱即用
6. **最终**: 既有消费项目 逐模块替换为 @zucker-framework 包，功能不退化
