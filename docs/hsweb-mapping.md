# hsweb / jetlinks → zucker-framework 映射表

本文档对照 Java 版 hsweb-framework 和 jetlinks-community 中的核心组件与 zucker-framework 中的 TypeScript 等价物。

## hsweb-core → @zucker/core

| hsweb Java 类/接口 | @zucker 包 | TypeScript 等价物 | 差异说明 |
|---|---|---|---|
| `GenericEntity` | @zucker/core | `GenericEntity` 接口 | 相同：id + createdAt + updatedAt |
| `RecordCreationEntity` | @zucker/core | `RecordCreationEntity` 接口 | 相同：增加 creatorId + modifierId |
| `TreeSortSupportEntity` | @zucker/core | `TreeSortSupportEntity` 接口 | 相同：增加 parentId + path + sortIndex + level |
| `IDGenerator` (接口) | @zucker/core | `generateId()` / `generateUUID()` / `generateSnowflakeId()` 函数 | hsweb 用接口+实现，zucker 用函数直接导出 |
| `BusinessException` | @zucker/core | `BusinessException` 类 | 相同，构造函数接受 message + code |
| `NotFoundException` | @zucker/core | `NotFoundException` 类 | 相同 |
| `ValidationException` | @zucker/core | `ValidationException` 类 | 增加了 `errors: Record<string, string[]>` 字段 |
| `UnAuthorizedException` | @zucker/core | `UnauthorizedException` 类 | 命名差异 |
| `ResponseMessage<T>` | @zucker/core | `ApiResponse<T>` 接口 | hsweb 用 `success` + `code` + `result`，zucker 用 `status` + `message` + `result` |
| `PagerResult<T>` | @zucker/core | `PaginatedResult<T>` 接口 | hsweb 返回 `total` + `pageIndex` + `data`，zucker 返回 `total` + `page` + `pageSize` + `totalPages` + `data` |
| `QueryParam` | @zucker/core | `QueryParam` 接口 | zucker 版简化了接口定义 |
| `Term` | @zucker/core | `Term` 接口 | 相同：column + termType + value + type + terms（嵌套） |
| `Diff` (工具类) | @zucker/core | `diff()` / `FieldChange` | hsweb 用静态方法，zucker 用函数 |
| `ExpressionUtils` (模板) | @zucker/core | `parseTemplate()` | 相同：支持 `${var.nested}` 变量替换 |
| `CreateGroup` / `UpdateGroup` | @zucker/core | `CreateGroup` / `UpdateGroup` 常量 | hsweb 用接口作分组标记，zucker 用字符串常量 |

## hsweb-commons-crud → @zucker/crud

| hsweb Java 类/接口 | @zucker 包 | TypeScript 等价物 | 差异说明 |
|---|---|---|---|
| `GenericReactiveCrudService` | @zucker/crud | `BaseService<T>` | hsweb 用 Mono/Flux 响应式，zucker 用 Promise/async |
| `GenericReactiveSaveCrudService` | @zucker/crud | `BaseService.saveOrUpdate()` | 合并到 BaseService |
| `GenericReactiveTreeSupportCrudService` | @zucker/crud | `TreeService<T>` | 相同：findAsTree / findChildren / moveNode / rebuildPath |
| `ReactiveServiceCrudController` | @zucker/crud | `BaseController(Entity)` 工厂函数 | hsweb 用继承，zucker 用 Mixin 工厂（解决 TypeScript 装饰器继承限制） |
| `QueryHelper` | @zucker/crud | `DynamicQueryService` + `DynamicQueryParamService` | 拆分为两个服务 |
| `TermExpressionParser` | @zucker/crud | `parseExpression()` 函数 | 相同：解析 SQL 风格 WHERE 表达式 |
| `QueryParam.of()` (FilterMap) | @zucker/crud | `parseFilterMap()` 函数 | 相同：解析 `{"field$op": value}` 格式 |
| `AbstractTermFragmentBuilder` | @zucker/crud | `IFilterOperator` 接口 + 14 个实现类 | hsweb 用 SQL fragment，zucker 生成 Prisma where 对象 |
| `DefaultDatabaseRepository` | @zucker/crud | `PrismaAdapter` | hsweb 用 R2DBC/JDBC，zucker 用 Prisma |

### 操作符映射

| hsweb TermType | zucker FilterOperatorType | 说明 |
|---|---|---|
| `eq` | `eq` | 等于 |
| `not` / `neq` | `neq` | 不等于 |
| `like` | `like` | 模糊匹配 |
| `nlike` | — | 未实现（可通过 neq + contains 组合） |
| `gt` / `gte` / `lt` / `lte` | `gt` / `gte` / `lt` / `lte` | 比较 |
| `in` / `nin` | `in` / `notIn` | 列表包含 |
| `isnull` / `notnull` | `isNull` (true/false) | 合并为一个操作符 |
| `btw` | `between` | 范围 |
| `enums` | — | 未实现（同 in） |

## hsweb-authorization → @zucker/auth

| hsweb Java 类/接口 | @zucker 包 | TypeScript 等价物 | 差异说明 |
|---|---|---|---|
| `Authentication` 接口 | @zucker/auth | `Authentication` 接口 | 相同：getUser / getPermissions / getDimensions / hasPermission |
| `Permission` 接口 | @zucker/auth | `Permission` 接口 | 相同：id + name + actions |
| `DimensionType` | @zucker/auth | `DimensionType` 接口 | 相同 |
| `Dimension` | @zucker/auth | `Dimension` 接口 | 相同 |
| `DimensionProvider` (SPI) | @zucker/auth | `DimensionProvider` 接口 | hsweb 用 Java SPI，zucker 用 NestJS DI（`DIMENSION_PROVIDERS` token） |
| `@Authorize` (注解) | @zucker/auth | `@Permissions()` 装饰器 | zucker 拆分为 @Permissions（字符串）和 @Resource/@Action（资源-动作） |
| `@Resource` + `@ResourceAction` (注解) | @zucker/auth | `@Resource()` + `@Action()` 装饰器 | 相同模型，zucker 额外提供 @QueryAction / @CreateAction / @UpdateAction / @DeleteAction 快捷装饰器 |
| `@Authorize(ignore=true)` | @zucker/auth | `@Public()` 装饰器 | 更清晰的语义 |
| `@DataAccess` | @zucker/auth | `@DataPermission()` 装饰器 | 相同：控制行级数据访问 |
| `AuthenticationHolder` | @zucker/auth | `@CurrentUser()` 参数装饰器 | hsweb 用 ThreadLocal，zucker 用 NestJS 请求上下文 |
| `TokenState` (枚举) | @zucker/auth | `TokenState` 枚举 | 相同：NORMAL / EXPIRED / LOCK / DENY / OFFLINE |
| `UserToken` | @zucker/auth | `TokenInfo` 接口 | 相同 |
| `PermissionService` (Spring 实现) | @zucker/auth | `PermissionService` | 相同功能 |
| `AuthenticationManager` | @zucker/auth | `TokenService` | 管理 Token 生命周期 |
| — | @zucker/auth | `RoleHierarchyService` | 新增：角色层级展开 |
| — | @zucker/auth | `PermissionScannerService` | 新增：自动扫描 @Resource/@Action 装饰器注册权限 |

### AOP → NestJS 对照

| Java / Spring 机制 | NestJS / zucker 等价物 |
|---|---|
| `@Aspect` + `@Around` | Guard / Interceptor |
| `@PreAuthorize` | `PermissionsGuard`（全局 Guard） |
| `HandlerInterceptor` | NestJS `Interceptor` |
| `@EventListener` | `@OnEvent()` 装饰器 |
| Spring AOP 切面 | NestJS Guard + Interceptor + Pipe 管道 |
| `ThreadLocal` | NestJS `ExecutionContext` / Request 对象 |
| `Mono<T>` / `Flux<T>` | `Promise<T>` / `AsyncIterable<T>` |

## hsweb-access-logging → @zucker/logging

| hsweb Java 类/接口 | @zucker 包 | TypeScript 等价物 | 差异说明 |
|---|---|---|---|
| `@AccessLogger` (注解) | @zucker/logging | `@AccessLogger()` 装饰器 | 相同：标记需要记录日志的端点 |
| `AccessLoggerListener` (接口) | @zucker/logging | `ACCESS_LOG_EVENT` + `@OnEvent()` | hsweb 用接口回调，zucker 用事件驱动 |
| `AccessLoggerInfo` | @zucker/logging | `AccessLogPayload` 接口 | 相同字段 |
| `OperationLog` | @zucker/logging | `OperationLogPayload` 接口 | 相同 |
| `AccessLoggerInterceptor` (Spring) | @zucker/logging | `AccessLoggerInterceptor` (NestJS) | 相同功能，不同框架实现 |

## hsweb-system-* → @zucker 各包

| hsweb 模块 | @zucker 包 | 说明 |
|---|---|---|
| `hsweb-system-dictionary` | @zucker/dictionary | DictionaryService + DictionaryItemService + @DictField 装饰器 |
| `hsweb-system-file` | @zucker/storage | FileManager 接口 + LocalStorage / S3Storage |

## jetlinks 组件 → @zucker 各包

### 已移植

| jetlinks Java 组件 | @zucker 包 | TypeScript 等价物 | 说明 |
|---|---|---|---|
| `EventBus` (主题通配符) | @zucker/event | `TopicEventBus` + `DefaultTopicEventBus` | 支持 `*` 和 `**` 通配符 |
| 实体生命周期事件 | @zucker/event | `EntityEvent` + `EntityEventType` + `EntityEventPhase` | Prepare → Before → After 三阶段 |
| `ConfigManager` | @zucker/config | `ConfigService` | DB + 内存缓存 + 变更事件 |
| `notify-component` | @zucker/notification | `NotifierProvider` + `TemplateService` | 多通道通知 |
| `Provider` SPI 模式 | @zucker/provider | `ProviderRegistry` + `DefaultProviderRegistry` | 注册中心 + Hook 生命周期 |
| `StrategyManager` | @zucker/provider | `StrategyManager` + `DefaultStrategyManager` | 可插拔策略 |
| `DataReferenceManager` | @zucker/reference | `DataReferenceManager` + `@PreventDeleteIfReferenced` | 引用检查 + 删除保护 |
| `script-component` | @zucker/script | `ScriptFactory` + `createSandbox` + `ExposedScriptRegistry` | JS 沙箱执行 |
| `rule-engine-component` | @zucker/rule-engine | `RuleEngineService` + 条件/动作/触发器 | 条件 DSL + 动作执行 |
| `configure-component` (集群) | @zucker/cluster | `RedisClusterManager` + `RedisDistributedLock` + `DistributedEventBus` | Redis 集群管理 |
| `ProviderManager` (AI) | @zucker/ai | `AIProviderManager` | 多 AI 供应商注册/切换 |

### 未移植（Phase 5 IoT 专用）

| jetlinks Java 组件 | 计划包 | 状态 |
|---|---|---|
| `things-component` | @zucker/things | Phase 5 规划 |
| `gateway-component` + `network-component` | @zucker/gateway + @zucker/network | Phase 5 规划 |
| `timeseries-component` | @zucker/timeseries | Phase 5 规划 |

详见 [jetlinks 移植路线图](./jetlinks-roadmap.md)。

## API 风格差异总结

### 响应式 → 异步

```java
// hsweb (Java - Spring WebFlux)
public Mono<User> findById(String id) {
    return repository.findById(id);
}

public Flux<User> findAll() {
    return repository.findAll();
}
```

```typescript
// zucker (TypeScript - NestJS)
async findById(id: string): Promise<User> {
  return this.db.model('user').findUnique({ where: { id } });
}

async findAll(): Promise<User[]> {
  return this.db.model('user').findMany();
}
```

### AOP 切面 → NestJS 装饰器 + Guard

```java
// hsweb (Java - Spring AOP)
@Authorize(permission = "user", action = "query")
@GetMapping("/{id}")
public Mono<User> getById(@PathVariable String id) { ... }
```

```typescript
// zucker (TypeScript - NestJS)
@Resource({ id: 'user', name: '用户管理' })
@Controller('users')
export class UserController {
  @Get(':id')
  @QueryAction()
  async getById(@Param('id') id: string) { ... }
}
```

### SPI 机制 → NestJS DI

```java
// hsweb / jetlinks (Java SPI)
@Component
public class MyDimensionProvider implements DimensionProvider {
    @Override
    public Flux<DimensionType> getAllType() { ... }
}
```

```typescript
// zucker (NestJS DI)
@Injectable()
export class MyDimensionProvider implements DimensionProvider {
  async getAllTypes(): Promise<DimensionType[]> { ... }
}

// 模块注册
@Module({
  providers: [
    { provide: DIMENSION_PROVIDERS, useClass: MyDimensionProvider },
  ],
})
```

### EventBus topic 格式

```java
// jetlinks (Java)
eventBus.publish("/device/"+deviceId+"/message/property", message)
        .subscribe();
eventBus.subscribe(Subscription.of("subscriber", "/device/*/message/**"))
        .subscribe(payload -> { ... });
```

```typescript
// zucker (TypeScript)
await eventBus.publish(`/device/${deviceId}/message/property`, message);

const sub = eventBus.subscribe('/device/*/message/**', (payload, topic) => {
  // 处理消息
});
// 取消订阅
sub.unsubscribe();
```
