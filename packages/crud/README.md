# CRUD

## Services with custom dependency injection

Extend `CrudService<T>` when your Nest service has a custom constructor. Inject the configured `DATABASE_ADAPTER` explicitly and pass it, `DynamicQueryService`, and the model name to `super`. `CrudService` has no inherited Nest parameter tokens, so product dependencies cannot accidentally resolve as a database adapter or event bus. `CrudEntity` requires an ID and permits optional timestamps; the host chooses the ordering field. Existing `BaseService<T>` retains its standard injected constructor and delegates to the same implementation.

`BaseController(Entity, options)` accepts `only` (enabled methods), `routes` (method/path overrides and additional decorators), and `queryDto` (the runtime query DTO used by Nest validation). Defaults preserve the existing Framework HTTP surface; single-record `saveOrUpdate` must be explicitly enabled. Pass application policy as a configuration object instead of mutating generated prototypes in consumers. Controller factories are isolated, so configuring one resource does not change another.

## Validated HTTP query DTO

`QueryParamDto` supplies transformation and validation for filters, orderBy, page (default 1), pageSize (default 10, maximum 100), and comma-separated includes/excludes. Non-string projection inputs remain subject to validation instead of throwing inside the transform. `QueryParamEntity` remains the query-builder API; it is not replaced by the transport DTO.

### SELECT-first 分页计数

`DynamicQueryParam.inferTotal: true` 显式启用先查询页面、再按需 COUNT：

```ts
await service.findAll({ page: 1, pageSize: 20, orderBy: 'createdAt desc,id asc', inferTotal: true });
```

首屏不足一页（含零条）或后续非空末页直接得到 `skip + data.length`；满页、后续空页仍 COUNT。
默认查询顺序不变；传入 `total` 优先复用，`parallelPager: true` 优先并行执行。无分页时仍返回全部数据。
`QueryParamEntity` 构造和 clone 保留该选项。`queryPager` 仍保留先确定总数、修正越界页码的契约，
不是 SELECT-first 查询的快捷入口；需要此优化时使用 `findAll` 或 `DynamicQueryService.findMany`。

消费者必须提供确定性排序（例如追加唯一 `id`）；页内查询不应做额外去重或截断。
此选项不创建数据库快照，多个语句和翻页之间仍可能遇到并发增删；需要一致快照时由消费者绑定事务适配器和所需隔离级别。

### SoftDeleteService 隔离契约

`SoftDeleteService` 使用服务私有的活动记录适配器视图，不改变共享 `DatabaseAdapter`。
继承的可选/批量读取、count、动态查询、exists、queryPager、链式查询和更新/保存入口均限制根记录 `deletedAt IS NULL`。
动态过滤的 `terms/where/filter/filters` 与可信条件分别解析后 AND 合并，不能用其他过滤表示绕过。
普通单条、批量和乐观锁更新把活动条件直接传给数据库；`deleteBatch` 也执行软删除。
`transaction` 回调接收同样受限的适配器视图。

生命周期字段由 `delete/softDelete/restore` 管理，普通写入显式携带 `deletedAt` 会拒绝
（创建允许 `null`，并默认写入 `null`）。如旧代码把完整实体直接传入 update/save，需先去掉 `deletedAt`。
`findOne/findAll` 的第二参数 `{ includeDeleted: true }` 仅为可信调用入口；应用不得直接透传 HTTP 查询参数作为该选项。
`restore` 以读到的删除时间作为状态条件；`forceDelete` 可物理删除回收站记录，保留删除事件。
旧 `deleteMany(..., { includeDeleted: true })` 兼容保留，会重新设置匹配记录的删除时间，应谨慎使用。

适配器必须支持原子条件更新及带额外条件的唯一读取/更新（Prisma 的 extended WhereUniqueInput），
数据库必须具有唯一 ID 约束与可空 `deletedAt` 字段。该隔离仅约束服务目标模型的根操作，
不递归过滤关系 include/select、嵌套写入、其他模型、原始 SQL 或应用直接访问的数据库客户端。
所有权、删除前任务检查、关联资源事务和嵌套关系政策由消费者实现；此服务不能替代全局 ORM 数据访问策略。

自定义 SQL/相关性排名等查询可直接使用公开 `resolvePageTotal(rowCount, { skip, take }, count)`，
无需绕过现有事务或把产品查询改写成动态查询。`withActiveRecordWhere(where)` 合并活动记录条件，
保留顶层唯一键和原始过滤（包括所有权、版本条件）；消费者可在自己的 Prisma extension 中复用，
同时继续维护回收站访问权限、关系投影与嵌套写入政策。两者从 `@zucker-framework/crud` 根入口导出。
