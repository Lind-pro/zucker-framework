# API 参考

按包分组列出 zucker-framework 各包导出的核心接口、类和函数。

---

## @zucker/core

基础类型、实体基类、ID 生成、异常层级、工具函数。

### 接口

```typescript
// 数据库适配器
interface DatabaseAdapter {
  model(name: string): ModelOperations;
  $transaction<T>(fn: (adapter: DatabaseAdapter) => Promise<T>): Promise<T>;
}

interface ModelOperations<T = any> {
  findUnique(args: any): Promise<T | null>;
  findMany(args?: any): Promise<T[]>;
  create(args: any): Promise<T>;
  update(args: any): Promise<T>;
  delete(args: any): Promise<T>;
  count(args?: any): Promise<number>;
  createMany(args: any): Promise<{ count: number }>;
  updateMany(args: any): Promise<{ count: number }>;
  deleteMany(args?: any): Promise<{ count: number }>;
}

// 实体层级
interface GenericEntity { id: string; createdAt: Date; updatedAt: Date; }
interface RecordCreationEntity extends GenericEntity { creatorId?: string; modifierId?: string; }
interface TreeSortSupportEntity extends RecordCreationEntity {
  parentId?: string | null; path?: string; sortIndex?: number; level?: number;
  children?: TreeSortSupportEntity[];
}

// 响应类型
interface ApiResponse<T> { status: number; message: string; result: T; timestamp: number; }
interface PaginatedResult<T> { data: T[]; total: number; page: number; pageSize: number; totalPages: number; }
interface QueryParam { page?: number; pageSize?: number; where?: Record<string, unknown>; orderBy?: ...; includes?: string[]; excludes?: string[]; }
interface Term { column: string; termType: string; value: unknown; type?: 'and' | 'or'; terms?: Term[]; }
```

### 异常类

```typescript
class BusinessException extends Error {
  readonly code: string;
  constructor(message: string, code?: string);
}
class NotFoundException extends BusinessException {
  constructor(message?: string);
}
class ValidationException extends BusinessException {
  readonly errors: Record<string, string[]>;
}
class UnauthorizedException extends BusinessException {
  constructor(message?: string);
}
class ForbiddenException extends BusinessException {
  constructor(message?: string);
}
```

### 函数

```typescript
// ID 生成
function generateId(): string; // CUID2
function generateUUID(): string; // Node.js crypto UUID
function generateSnowflakeId(): string; // 雪花算法

// 对象 Diff
interface FieldChange {
  field: string;
  oldValue: unknown;
  newValue: unknown;
}
function diff(
  oldObj: Record<string, unknown>,
  newObj: Record<string, unknown>,
  ignoreFields?: string[],
): FieldChange[];

// 模板解析
function parseTemplate(template: string, variables: Record<string, unknown>): string;
// 支持 ${var} 和 ${obj.nested.field} 格式
```

### 常量

```typescript
const CreateGroup = 'create';
const UpdateGroup = 'update';
```

---

## @zucker/common

NestJS 通用中间件、拦截器、过滤器、管道。

```typescript
class TransformInterceptor    // 响应自动包装为 ApiResponse 格式
class HttpExceptionFilter     // 全局异常过滤器
class RequestLoggerMiddleware // 请求日志中间件
class TrimStringPipe          // 字符串自动 trim

class ZuckerCommonModule      // 模块（自动注册以上组件）
```

---

## @zucker/event

实体生命周期事件 + TopicEventBus。

### 枚举和接口

```typescript
enum EntityEventType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  QUERY = 'query',
}
enum EntityEventPhase {
  PREPARE = 'prepare',
  BEFORE = 'before',
  AFTER = 'after',
}

interface EntityEvent<T = unknown> {
  type: EntityEventType;
  phase: EntityEventPhase;
  entityType: string;
  entity: T | T[];
  timestamp: number;
}

interface TopicEventBus {
  publish(topic: string, payload: unknown): Promise<void>;
  subscribe(
    topicPattern: string,
    handler: (payload: unknown, topic: string) => void | Promise<void>,
  ): { unsubscribe: () => void };
}

interface EntityEventListener<T = unknown> {
  onEvent(event: EntityEvent<T>): void | Promise<void>;
}
interface AsyncEvent<T = unknown> {
  payload: T;
  timestamp: number;
  handled: boolean;
  markHandled(): void;
}
```

### 函数和类

```typescript
function createEntityEvent<T>(type, phase, entityType, entity): EntityEvent<T>;
function getEntityEventName(entityType, type, phase): string; // "entity.{type}.{eventType}.{phase}"
function createAsyncEvent<T>(payload: T): AsyncEvent<T>;

class CreatorEventListener implements EntityEventListener;  // PREPARE 阶段自动填充 creatorId/modifierId
class DefaultTopicEventBus implements TopicEventBus;        // EventEmitter2 实现，支持 * 和 ** 通配符

class ZuckerEventModule { static forRoot(): DynamicModule; }
const TOPIC_EVENT_BUS: string;  // DI token
```

---

## @zucker/crud

CRUD 基类、动态查询、操作符引擎。

### 类

```typescript
abstract class BaseService<T extends GenericEntity> {
  constructor(db: DatabaseAdapter, dynamicQuery: DynamicQueryService, modelName: string, eventBus?: TopicEventBus, options?: { defaultOrderField?: string });
  create(data: Partial<T>): Promise<T>;
  update(id: string, data: Partial<T>): Promise<T>;
  delete(id: string): Promise<T>;
  findOne(id: string): Promise<T>;
  findAll(query: DynamicQueryParam): Promise<PaginatedResult<T>>;
  saveOrUpdate(data: Partial<T>): Promise<T>;
  createMany(data: Partial<T>[]): Promise<{ count: number }>;
  updateMany(where: Record<string, unknown>, data: Partial<T>): Promise<{ count: number }>;
  deleteMany(where: Record<string, unknown>): Promise<{ count: number }>;
  softDelete(id: string): Promise<T>;
  restore(id: string): Promise<T>;
  transaction<R>(fn: (db: DatabaseAdapter) => Promise<R>): Promise<R>;
}

abstract class TreeService<T extends TreeSortSupportEntity> extends BaseService<T> {
  findAsTree(): Promise<T[]>;
  findChildren(parentId: string): Promise<T[]>;
  findWithChildren(id: string): Promise<T[]>;
  rebuildPath(): Promise<void>;
  moveNode(id: string, newParentId: string | null): Promise<T>;
}

function BaseController<T>(EntityClass: Type<T>): Type<BaseControllerHost<T>>;
// 生成的控制器包含: create / findOne / findAll / saveOrUpdate / update / delete / createMany / updateMany / deleteMany

class PrismaAdapter implements DatabaseAdapter;
```

### 动态查询

```typescript
interface DynamicQueryParam {
  filters?: string; // JSON 编码的 FilterMap
  orderBy?: string; // "field desc,field2 asc"
  page?: number; // 默认 1
  pageSize?: number; // 默认 10
  total?: number; // 传入跳过 count
  parallelPager?: boolean; // count + findMany 并发
  includes?: string[]; // 只选字段
  excludes?: string[]; // 排除字段
}

class DynamicQueryService {
  findMany(
    model: string,
    queryParam: DynamicQueryParam,
    defaultOrderField?: string,
  ): Promise<PaginatedResult>;
  findOne(model: string, id: string, includes?: string[], excludes?: string[]): Promise<any>;
}

class DynamicQueryParamService {
  parseFilters(filters: Record<string, unknown>): Record<string, unknown>;
  parseOrderBy(orderBy?: string, defaultField?: string): Record<string, string>[];
  parsePagination(page?: number, pageSize?: number): { skip: number; take: number };
  parseSelect(includes?: string[], excludes?: string[]): Record<string, boolean> | undefined;
}
```

### 表达式解析

```typescript
function parseExpression(expression: string): Term[]; // SQL 风格: "name = '张三' and age > 16"
function parseFilterMap(filterMap: Record<string, unknown>): Term[]; // {"name$like": "张"}
```

### 操作符

```typescript
type FilterOperatorType =
  | 'eq'
  | 'neq'
  | 'like'
  | 'contains'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'in'
  | 'notIn'
  | 'isNull'
  | 'between'
  | 'has'
  | 'hasSome';

interface IFilterOperator {
  readonly operatorType: FilterOperatorType;
  apply(field: string, value: unknown): Record<string, unknown> | null;
}

class FilterOperatorFactory {
  getOperator(operatorType: string): IFilterOperator | null;
  applyFilter(field: string, operatorType: string, value: unknown): Record<string, unknown> | null;
  getSupportedOperators(): FilterOperatorType[];
  isOperatorSupported(operatorType: string): boolean;
}

// 14 个内置操作符类: EqualsOperator, NotEqualsOperator, LikeOperator, ContainsOperator,
// GtOperator, GteOperator, LtOperator, LteOperator, InOperator, NotInOperator,
// IsNullOperator, BetweenOperator, HasOperator, HasSomeOperator
```

### 模块

```typescript
class ZuckerCrudModule {
  static forRoot(options: { adapterClass: Type<DatabaseAdapter> }): DynamicModule;
}
const DATABASE_ADAPTER: string; // DI token
```

---

## @zucker/auth

认证授权：JWT、权限检查、数据权限、维度权限。

### 装饰器

```typescript
const Public: () => ClassDecorator & MethodDecorator;
const Permissions: (...permissions: string[]) => MethodDecorator;
const RequirePermissions: typeof Permissions; // 别名
const Resource: (options: ResourceOptions) => ClassDecorator;
const Action: (options: ActionOptions) => MethodDecorator;
const QueryAction: (name?: string, description?: string) => MethodDecorator;
const CreateAction: (name?: string, description?: string) => MethodDecorator;
const UpdateAction: (name?: string, description?: string) => MethodDecorator;
const DeleteAction: (name?: string, description?: string) => MethodDecorator;
const SaveAction: (name?: string, description?: string) => MethodDecorator;
const CurrentUser: ParameterDecorator; // @CurrentUser() 或 @CurrentUser('id')
const DataPermission: (options?: DataPermissionOptions | string) => MethodDecorator;
const SkipDataPermission: () => MethodDecorator;

interface ResourceOptions {
  id: string;
  name: string;
  description?: string;
  optionalFields?: Array<{ name: string; description: string }>;
}
interface ActionOptions {
  action: string;
  name: string;
  description?: string;
}
interface DataPermissionOptions {
  dataType?: string;
  skipDataPermission?: boolean;
}
```

### Guards

```typescript
class JwtAuthGuard;         // JWT token 验证
class PermissionsGuard;     // 权限检查（@Permissions 或 @Resource/@Action）
class DataPermissionGuard;  // 数据权限检查（所有权 + 维度 + 显式权限）
```

### 服务

```typescript
class PermissionService {
  hasPermission(userId: string, permissions: string[]): Promise<boolean>;
  hasDataPermission(userId: string, dataType: string, resourceId: string, action: string): Promise<boolean>;
}

class PermissionScannerService;   // 扫描 @Resource/@Action 装饰器，收集权限定义
class RoleHierarchyService;       // 角色层级展开
class DimensionService;           // 维度管理
class TokenService;               // Token 生命周期管理
class JwtStrategy;                // Passport JWT 策略
```

### 核心接口

```typescript
interface Authentication {
  getUser(): AuthUser;
  getPermissions(): Permission[];
  getDimensions(): Dimension[];
  hasPermission(permissionId: string, ...actions: string[]): boolean;
  hasDimension(type: string, ...ids: string[]): boolean;
  getAttributes(): Record<string, unknown>;
}

interface DimensionProvider {
  getAllTypes(): Promise<DimensionType[]>;
  getDimensionsByUserId(userId: string): Promise<Dimension[]>;
  getDimensionById(type: DimensionType, id: string): Promise<Dimension | null>;
  getUserIdsByDimensionId(dimensionId: string): Promise<string[]>;
}

enum TokenState {
  NORMAL,
  EXPIRED,
  LOCK,
  DENY,
  OFFLINE,
}
interface TokenInfo {
  token: string;
  userId: string;
  state: TokenState;
  signInTime: Date;
  lastRequestTime: Date;
  maxInactiveInterval?: number;
}
interface Permission {
  id: string;
  name: string;
  actions: string[];
  describe?: string;
}
interface Role {
  id: string;
  name: string;
  permissions: Permission[];
  parentId?: string;
}
interface AuthUser {
  id: string;
  username: string;
  [key: string]: unknown;
}
```

### 模块

```typescript
class ZuckerAuthModule {
  static forRoot(options: ZuckerAuthModuleOptions): DynamicModule;
}
interface ZuckerAuthModuleOptions {
  jwtSecret?: string;
  registerControllers?: boolean;
  dimensionProviders?: Array<...>;
}
```

---

## @zucker/logging

访问日志、结构化日志、PII 脱敏与业务语义审计事件。

```typescript
// 装饰器
const AccessLogger: (options: string | AccessLoggerOptions) => MethodDecorator;
interface AccessLoggerOptions {
  describe: string; action?: string; module?: string; targetType?: string;
  logParameters?: boolean; logResult?: boolean;
}

// 拦截器
class AccessLoggerInterceptor;  // 自动记录标记了 @AccessLogger 的端点

// 所有 StructuredLogger / AccessLogger / BusinessLogger / AuditLogger 输出
// 都在写出前经过 PiiFilter；字段名和内容模式均会脱敏，并限制深度与字符串长度。
class PiiFilter {
  sanitize(text: string): string;
  sanitizeObject<T extends Record<string, unknown>>(value: T): T;
  sanitizeValue(value: unknown): unknown;
}

class StructuredLogger; // JSON 日志，自动关联 correlationId 并统一脱敏

function normalizeCorrelationId(value: unknown): string;
// 只接受长度不超过 128 的安全字符；不可信值会替换为服务端 UUID。

// 事件（通过 @OnEvent 监听）
const ACCESS_LOG_EVENT = 'zucker.access-log';
const OPERATION_LOG_EVENT = 'zucker.operation-log';

interface AccessLogPayload {
  action: string; describe: string; module: string; userId?: string; username?: string;
  requestUrl: string; method: string; ip: string; userAgent?: string;
  requestTime: Date; responseTime: number; parameters?: Record<string, unknown>;
  result?: unknown; exception?: string;
}

interface OperationLogPayload {
  module: string; action: string; status: 'SUCCESS' | 'FAILED'; userId?: string;
  targetId?: string; targetType?: string; method: string; path: string;
  ipAddress: string; userAgent?: string; duration: number;
  requestData?: unknown; responseData?: unknown; errorMessage?: string;
}

interface AuditStore {
  append(entry: AuditEntry): Promise<void>;
  query(options: AuditQueryOptions): Promise<{ entries: AuditEntry[]; total: number }>;
}

class AuditLogger {
  constructor(store?: AuditStore, piiFilter?: PiiFilter);
  log(input: AuditLogInput): Promise<AuditEntry>;
  logRequired(input: AuditLogInput): Promise<AuditEntry>;
  query(options: AuditQueryOptions): Promise<{ entries: AuditEntry[]; total: number }>;
}

class ZuckerLoggingModule { static forRoot(): DynamicModule; }
```

`AuditLogger` 提供业务语义事件、统一脱敏和追加接口。兼容方法 `log()` 在存储失败
时记录脱敏错误但不阻断业务；安全敏感写操作应在业务事务中使用 fail-closed 的
`logRequired()`。框架不会自行保证持久化、不可变性、retention 或告警。默认
`InMemoryAuditStore` 只适用于开发/测试；生产业务必须提供自己的 `AuditStore`，
并在数据库/日志基础设施层实现相应约束。

---

## @zucker/config

动态配置管理（DB + 缓存 + 变更事件）。

```typescript
interface ConfigScope {
  id: string;
  name: string;
  isPublic: boolean;
  properties: ConfigPropertyDef[];
}
interface ConfigPropertyDef {
  key: string;
  name: string;
  type: string;
  defaultValue: unknown;
  description: string;
  readonly: boolean;
}

class ConfigService {
  get<T = string>(scope: string, key: string): Promise<T | undefined>;
  set(scope: string, key: string, value: unknown): Promise<void>;
  getAll(scope: string): Promise<Record<string, unknown>>;
  onChange(callback: (payload: ConfigChangePayload) => void): { unsubscribe: () => void };
  clearCache(scope?: string): void;
}

interface ConfigChangePayload {
  scope: string;
  key: string;
  oldValue: unknown;
  newValue: unknown;
}
const CONFIG_CHANGED_EVENT = 'zucker.config-changed';

class ZuckerConfigModule {
  static forRoot(): DynamicModule;
}
```

---

## @zucker/cache

多级缓存（内存 / Redis / 混合）。

```typescript
interface ICache<T = unknown> {
  get(key: string): Promise<T | undefined>;
  set(key: string, value: T, ttlMs?: number): Promise<void>;
  del(key: string): Promise<void>;
  has(key: string): Promise<boolean>;
  clear(): Promise<void>;
}

class MemoryCache<T> implements ICache<T>;      // LRU 内存缓存
class RedisCache<T> implements ICache<T>;        // Redis 缓存
class HybridCache<T> implements ICache<T>;       // 二级缓存（内存 + Redis）

enum CacheProvider { MEMORY, REDIS, HYBRID }
class ZuckerCacheModule { static forRoot(options: CacheModuleOptions): DynamicModule; }
```

---

## @zucker/notification

多通道通知。

```typescript
enum NotifyChannel { EMAIL, SMS, WECHAT, DINGTALK, WEBHOOK }

interface NotifierProvider {
  channel: NotifyChannel;
  send(message: NotifyMessage): Promise<void>;
}

interface NotifyMessage { channel: NotifyChannel; templateId?: string; to: string; variables: Record<string, string>; subject?: string; content?: string; }
interface NotifyTemplate { id: string; name: string; channel: NotifyChannel; content: string; variables: string[]; }
interface VariableSource { type: 'fixed' | 'upper' | 'relation'; key: string; value: string; }

// 内置 Provider
class EmailProvider implements NotifierProvider;
class WebhookProvider implements NotifierProvider;

class TemplateService;  // 模板渲染 + 变量解析
class ZuckerNotificationModule { static forRoot(options?: NotificationModuleOptions): DynamicModule; }
```

---

## @zucker/ai

AI 多供应商管理 + 调用包装。

```typescript
interface AIProvider {
  id: string;
  name: string;
  createModel(config: AIModelConfig): unknown;
}
interface AIModelConfig {
  apiKey: string;
  baseURL?: string;
  modelId: string;
  temperature?: number;
  maxTokens?: number;
  proxyUrl?: string;
}
interface AIScenario {
  id: string;
  name: string;
  provider: string;
  model: string;
  temperature: number;
  maxTokens: number;
}
interface AIInvocationResult {
  content: string;
  tokenUsage: { input: number; output: number };
  duration: number;
  cost: number;
}

class AIProviderManager {
  register(provider: AIProvider): void;
  get(providerId: string): AIProvider;
  getDefault(): AIProvider;
  setDefault(providerId: string): void;
  list(): AIProvider[];
  has(providerId: string): boolean;
}

class AIConfigService {
  getScenarioConfig(scenario: string): Promise<AIModelConfig>; // 从优先级配置源链加载（带 TTL 缓存）
  getScenarios(): Promise<AIScenario[]>;
  registerSource(source: AIConfigSource): void;
  unregisterSource(sourceId: string): boolean;
  getSources(): readonly AIConfigSource[];
  clearCache(): void;
}

interface AIConfigSource {
  id: string;
  priority?: number;
  failureMode?: 'continue' | 'throw';
  getScenarioConfig(scenario: string): Promise<AIModelConfig | null>;
  getScenarios?(): Promise<AIScenario[]>;
}

class EnvironmentAIConfigSource implements AIConfigSource {}
class RemoteAIConfigSource implements AIConfigSource {}
class DatabaseAIConfigSource implements AIConfigSource {}
class StaticAIConfigSource implements AIConfigSource {}

class AICallWrapper {
  callWithRetry<T>(fn: () => Promise<T>, options?: CallOptions): Promise<T>;
  // 指数退避重试 + 超时控制
}
interface CallOptions {
  timeoutMs?: number;
  maxAttempts?: number;
  context?: string;
}

class ZuckerAIModule {
  static forRoot(options?: { configSources?: AIConfigSource[] }): DynamicModule;
}
```

### Codex 订阅 Provider（可信内部自动化）

```typescript
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const store = new PostgresCredentialProfileStore({ pool });
await store.ensureSchema();
const auth = new CodexSubscriptionAuthClient({ store });
const provider = new OpenAICodexSubscriptionProvider({ store });
```

`auth.loginWithDeviceCode()` 负责一次性设备码登录，Provider 在访问令牌临近过期时自动刷新。刷新通过 PostgreSQL advisory lock 跨进程串行化，订阅 Token 只允许发送到 OpenAI 官方 `https://chatgpt.com/backend-api/codex` 端点。通用命令为 `zucker ai store init/login/status/profile import/smoke`。完整说明见 [Codex 订阅 Provider](./codex-subscription-provider.md)。

---

## @zucker/provider

通用 Provider 注册中心 + 策略管理。

```typescript
interface Provider<T> { id: string; instance: T; metadata?: Record<string, unknown>; }

interface ProviderRegistry<T> {
  register(provider: Provider<T>): void;
  unregister(id: string): void;
  get(id: string): Provider<T> | undefined;
  getAll(): Provider<T>[];
  getDefault(): Provider<T> | undefined;
  setDefault(id: string): void;
}
class DefaultProviderRegistry<T> implements ProviderRegistry<T> {
  addHook(hook: RegistryHook<T>): void;
  removeHook(hook: RegistryHook<T>): void;
}
interface RegistryHook<T> { onRegister?(provider: Provider<T>): void; onUnregister?(provider: Provider<T>): void; }

interface Strategy { id: string; }
interface StrategyManager<S extends Strategy> {
  register(strategy: S): void; unregister(id: string): void;
  get(id: string): S | undefined; getAll(): S[];
}
class DefaultStrategyManager<S> implements StrategyManager<S>;

interface LifecycleHook { ... }
class HookManager;
class ZuckerProviderModule;
```

---

## 其他包速览

### @zucker/dictionary

```typescript
class DictionaryService;          // 字典 CRUD
class DictionaryItemService;      // 字典项 CRUD（树形）
const DictField: (options: DictFieldOptions) => PropertyDecorator;  // 字段装饰器
```

### @zucker/rate-limiter

```typescript
interface LimiterConfig { points: number; duration: number; blockDuration?: number; }
interface RateLimiterModuleOptions {
  redisClient?: unknown;
  keyHashSecret?: string;
  globalGuard?: boolean;
  limiters: Record<string, LimiterConfig>;
}
class RateLimiterService;
class ZuckerRateLimiterModule {
  static forRoot(options: RateLimiterModuleOptions): DynamicModule;
  static forRootAsync(options: RateLimiterModuleAsyncOptions): DynamicModule;
}
```

`globalGuard: false` 可用于同步或异步注册，以便产品在应用组合根显式控制 Guard 顺序。
`keyHashSecret` 会在限流 key 写入内存或 Redis 前进行 HMAC-SHA256 派生。

### @zucker/storage

```typescript
interface FileManager {
  upload(buffer: Buffer, key: string, options?: UploadOptions): Promise<UploadResult>;
  uploadStream(stream: ReadStream, key: string, options?: UploadOptions): Promise<UploadResult>;
  download(key: string): Promise<{ stream: ReadStream; size: number }>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  getPublicUrl(key: string, expiresIn?: number): Promise<string>;
  list(prefix: string): Promise<FileInfo[]>;
}
class LocalFileStorage implements FileManager;
class S3Storage implements FileManager;
```

### @zucker/credit

```typescript
enum CreditTransactionType {
  GRANT,
  CONSUME,
  REFUND,
  EXPIRE,
}
class CreditService {
  grant(userId: string, amount: number, description: string, expireAt?: Date): Promise<void>;
  consume(userId: string, amount: number, description: string, orderId?: string): Promise<void>;
  refund(userId: string, amount: number, description: string, orderId?: string): Promise<void>;
  query(userId: string): Promise<{ balance: number; transactions: any[] }>;
  checkExpired(): Promise<number>;
}
```

### @zucker/reference

```typescript
class DataReferenceManager;
const PreventDeleteIfReferenced: () => MethodDecorator;
class ReferenceGuard;
```

### @zucker/script

```typescript
class JavaScriptScriptFactory;         // 编译 + 执行 JS 脚本
function createSandbox(options?: SandboxOptions): Sandbox;  // 安全沙箱
class ExposedScriptRegistry;           // 注册暴露给脚本的方法
```

### @zucker/rule-engine

```typescript
enum RuleConditionType { TERMS, EXPRESSION, SCRIPT }
enum RuleTriggerType { EVENT, TIMER, MANUAL }
enum RuleActionType { NOTIFY, HTTP, SCRIPT }

class RuleEngineService;    // 规则 CRUD + 执行引擎
class TermsEvaluator;       // 条件评估（Term 匹配）
class ExpressionEvaluator;  // 表达式评估
class NotifyAction;         // 通知动作
class HttpAction;           // HTTP 调用动作
class ScriptAction;         // 脚本执行动作
class EventTrigger;         // 事件触发器
class TimerTrigger;         // 定时触发器
```

### @zucker/monitoring

```typescript
class ErrorTracker;               // 错误追踪（分类 + 聚合）
class HealthCheckService;          // 健康检查
class InMemoryMetricsCollector;    // 指标收集
function renderPrometheusMetrics(registry: MetricsRegistry): string;
function getProcessUptime(startedAtMs: number, nowMs?: number): ProcessUptimeSnapshot;
enum HealthStatus { UP, DOWN, DEGRADED }
```

### @zucker/cluster

```typescript
class RedisClusterManager;     // Redis 节点注册 + 心跳
class RedisDistributedLock;    // Redis SETNX 分布式锁
class DistributedEventBus;     // Redis pub/sub EventBus
```
