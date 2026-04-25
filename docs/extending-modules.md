# 模块扩展指南

本文档说明如何在 zucker-framework 中添加新业务模块、自定义 CRUD 行为、使用事件系统、权限控制、通知和 AI 等能力。

## 添加新业务 Module（完整步骤）

### 1. 定义 Prisma 模型

```prisma
model Product {
  id          String   @id @default(cuid())
  name        String
  price       Float
  categoryId  String?
  parentId    String?  // 树形结构支持
  path        String?
  sortIndex   Int      @default(0)
  level       Int      @default(0)
  userId      String?
  creatorId   String?
  modifierId  String?
  deletedAt   DateTime?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
}
```

### 2. 创建 Service

```typescript
import { Injectable, Inject } from '@nestjs/common';
import { BaseService } from '@zucker/crud';
import { DATABASE_ADAPTER } from '@zucker/crud';
import { DynamicQueryService } from '@zucker/crud';
import { DatabaseAdapter } from '@zucker/core';

interface Product {
  id: string;
  name: string;
  price: number;
  categoryId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class ProductService extends BaseService<Product> {
  constructor(
    @Inject(DATABASE_ADAPTER) db: DatabaseAdapter,
    dynamicQuery: DynamicQueryService,
  ) {
    super(db, dynamicQuery, 'product');
  }

  async findByCategory(categoryId: string): Promise<Product[]> {
    return this.db.model(this.modelName).findMany({
      where: { categoryId },
    });
  }
}
```

### 3. 创建 Controller

```typescript
import { Controller, Get, Param } from '@nestjs/common';
import { BaseController } from '@zucker/crud';
import { Resource, QueryAction, CreateAction, UpdateAction, DeleteAction } from '@zucker/auth';
import { ProductService } from './product.service';

class Product {
  id: string;
  name: string;
  price: number;
}

@Controller('products')
@Resource({ id: 'product', name: '产品管理' })
export class ProductController extends BaseController(Product) {
  constructor(private readonly productService: ProductService) {
    super(productService);
  }

  @Get('category/:categoryId')
  @QueryAction()
  async findByCategory(@Param('categoryId') categoryId: string) {
    return this.productService.findByCategory(categoryId);
  }
}
```

### 4. 创建 Module 并注册

```typescript
import { Module } from '@nestjs/common';
import { ProductService } from './product.service';
import { ProductController } from './product.controller';

@Module({
  controllers: [ProductController],
  providers: [ProductService],
  exports: [ProductService],
})
export class ProductModule {}
```

在 `AppModule` 中导入：

```typescript
@Module({
  imports: [
    // ... 框架模块
    ProductModule,
  ],
})
export class AppModule {}
```

---

## BaseService 方法和覆盖点

### 所有方法

| 方法 | 签名 | 说明 |
|------|------|------|
| `create` | `(data: Partial<T>) => Promise<T>` | 创建记录，触发 PREPARE/BEFORE/AFTER 事件 |
| `update` | `(id: string, data: Partial<T>) => Promise<T>` | 更新记录，触发 PREPARE/BEFORE/AFTER 事件 |
| `delete` | `(id: string) => Promise<T>` | 删除记录，触发 BEFORE/AFTER 事件 |
| `findOne` | `(id: string) => Promise<T>` | 按 ID 查询，不存在抛 NotFoundException |
| `findAll` | `(query: DynamicQueryParam) => Promise<PaginatedResult<T>>` | 分页查询，支持动态过滤和排序 |
| `saveOrUpdate` | `(data: Partial<T>) => Promise<T>` | 有 id 更新，无 id 创建 |
| `createMany` | `(data: Partial<T>[]) => Promise<{ count: number }>` | 批量创建 |
| `updateMany` | `(where, data) => Promise<{ count: number }>` | 按条件批量更新 |
| `deleteMany` | `(where) => Promise<{ count: number }>` | 按条件批量删除 |
| `softDelete` | `(id: string) => Promise<T>` | 软删除（设置 deletedAt） |
| `restore` | `(id: string) => Promise<T>` | 恢复软删除 |
| `transaction` | `(fn: (db) => Promise<R>) => Promise<R>` | 事务操作 |

### 覆盖方法

可以覆盖任何方法添加业务逻辑：

```typescript
@Injectable()
export class OrderService extends BaseService<Order> {
  // 覆盖 create，添加业务校验
  async create(data: Partial<Order>): Promise<Order> {
    await this.validateOrder(data);
    return super.create(data);
  }

  // 覆盖 delete，添加关联清理
  async delete(id: string): Promise<Order> {
    await this.deleteOrderItems(id);
    return super.delete(id);
  }
}
```

### 可配置项

```typescript
// 构造函数中可设置默认排序字段
super(db, dynamicQuery, 'order', eventBus, { defaultOrderField: 'orderDate' });
```

---

## BaseController 端点和自定义

BaseController 工厂函数生成包含 9 个标准端点的控制器基类：

| HTTP 方法 | 路径 | 方法名 | 说明 |
|-----------|------|--------|------|
| POST | `/` | `create` | 创建记录 |
| GET | `/` | `findAll` | 分页查询 |
| GET | `/:id` | `findOne` | 查询单条 |
| PATCH | `/save` | `saveOrUpdate` | 保存或更新 |
| PATCH | `/:id` | `update` | 更新记录 |
| DELETE | `/:id` | `delete` | 删除记录 |
| POST | `/batch` | `createMany` | 批量创建 |
| PUT | `/batch` | `updateMany` | 批量更新 |
| DELETE | `/batch` | `deleteMany` | 批量删除 |

覆盖端点：

```typescript
@Controller('orders')
export class OrderController extends BaseController(Order) {
  // 覆盖 create，添加额外逻辑
  @Post()
  async create(@Body() data: Partial<Order>): Promise<Order> {
    // 自定义逻辑
    return this.service.create(data);
  }
}
```

---

## 动态查询

### DynamicQueryParam 参数

前端通过 query string 传递查询参数：

| 参数 | 类型 | 说明 | 示例 |
|------|------|------|------|
| `filters` | JSON string | FilterMap 格式的过滤条件 | `{"name$like":"张"}` |
| `orderBy` | string | 排序字段 | `createdAt desc,name asc` |
| `page` | number | 页码（从 1 开始） | `1` |
| `pageSize` | number | 每页大小 | `10` |
| `total` | number | 客户端传入 total 可跳过 count 查询 | `100` |
| `parallelPager` | boolean | 是否并行执行 count + findMany | `true` |
| `includes` | string[] | 只返回指定字段 | `["id","name"]` |
| `excludes` | string[] | 排除指定字段 | `["content"]` |

### FilterMap 语法

格式：`{"字段$操作符": "值"}`，不带 `$` 默认 `eq`。

```json
{
  "name$like": "张三",
  "age$gte": 18,
  "status": "active",
  "role$in": ["admin", "editor"],
  "score$between": [60, 100],
  "deletedAt$isNull": true,
  "$or$email$like": "@gmail.com"
}
```

支持嵌套条件：

```json
{
  "$nest": {
    "name$like": "张",
    "$or$name$like": "李"
  },
  "status": "active"
}
```

### 14 种操作符

| 操作符 | 说明 | 示例 |
|--------|------|------|
| `eq` | 等于（默认） | `{"name": "张三"}` |
| `neq` | 不等于 | `{"name$neq": "张三"}` |
| `like` | 模糊匹配（不区分大小写） | `{"name$like": "张"}` |
| `contains` | 包含（同 like） | `{"name$contains": "张"}` |
| `gt` | 大于 | `{"age$gt": 18}` |
| `gte` | 大于等于 | `{"age$gte": 18}` |
| `lt` | 小于 | `{"age$lt": 60}` |
| `lte` | 小于等于 | `{"age$lte": 60}` |
| `in` | 在列表中 | `{"status$in": ["a","b"]}` |
| `notIn` | 不在列表中 | `{"status$notIn": ["x"]}` |
| `isNull` | 是否为 null | `{"deletedAt$isNull": true}` |
| `between` | 范围 | `{"age$between": [18,60]}` |
| `has` | 数组包含（单值） | `{"tags$has": "hot"}` |
| `hasSome` | 数组包含任一 | `{"tags$hasSome": ["a","b"]}` |

### 表达式解析

`parseExpression` 支持 SQL 风格的 WHERE 表达式：

```typescript
import { parseExpression } from '@zucker/crud';

const terms = parseExpression("name = '张三' and age > 16 or status = 'active'");
// 结果: [
//   { column: 'name', termType: 'eq', value: '张三', type: 'and' },
//   { column: 'age', termType: 'gt', value: '16', type: 'and' },
//   { column: 'status', termType: 'eq', value: 'active', type: 'or' },
// ]
```

---

## 实体事件监听

BaseService 在 CRUD 操作时自动发射实体生命周期事件。

### 事件阶段

每种操作（CREATE/UPDATE/DELETE/QUERY）有三个阶段：

| 阶段 | 说明 | 可修改数据 | 可取消操作 |
|------|------|-----------|-----------|
| `PREPARE` | 准备阶段 | 可以 | 否 |
| `BEFORE` | 执行前 | 可以 | 可以 |
| `AFTER` | 执行后 | 否（只读） | 否 |

### 事件名格式

`entity.{entityType}.{eventType}.{phase}`

例如：`entity.product.create.before`

### 使用 @OnEvent 监听

```typescript
import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { EntityEvent, EntityEventType, EntityEventPhase } from '@zucker/event';

@Injectable()
export class ProductEventListener {
  // 监听产品创建前事件
  @OnEvent('entity.product.create.before')
  async onProductCreateBefore(event: EntityEvent) {
    const product = event.entity as any;
    // 校验或修改数据
    if (product.price < 0) {
      throw new Error('价格不能为负数');
    }
  }

  // 监听产品创建后事件
  @OnEvent('entity.product.create.after')
  async onProductCreated(event: EntityEvent) {
    // 发送通知、更新缓存等副作用
  }

  // 使用通配符匹配所有产品事件
  @OnEvent('entity.product.*.*')
  async onAnyProductEvent(event: EntityEvent) {
    // 审计日志
  }
}
```

### 内置监听器

**CreatorEventListener** — PREPARE 阶段自动填充 `creatorId`/`createdAt` 和 `modifierId`/`updatedAt`：

```typescript
import { CreatorEventListener } from '@zucker/event';

// 在模块中注册
const creatorListener = new CreatorEventListener(() => getCurrentUserId());
```

### TopicEventBus 发布/订阅

TopicEventBus 支持层级化 topic 和通配符，适用于跨模块通信：

```typescript
import { Inject, Injectable } from '@nestjs/common';
import { TopicEventBus, TOPIC_EVENT_BUS } from '@zucker/event';

@Injectable()
export class DeviceService {
  constructor(
    @Inject(TOPIC_EVENT_BUS) private readonly eventBus: TopicEventBus,
  ) {}

  // 发布事件
  async onDeviceMessage(deviceId: string, message: unknown) {
    await this.eventBus.publish(`/device/${deviceId}/message`, message);
  }

  // 订阅事件（支持通配符）
  onModuleInit() {
    // * 匹配单级
    this.eventBus.subscribe('/device/*/message', (payload, topic) => {
      console.log(`收到设备消息: ${topic}`, payload);
    });

    // ** 匹配多级
    this.eventBus.subscribe('/device/**', (payload, topic) => {
      console.log(`设备相关事件: ${topic}`);
    });
  }
}
```

---

## 权限装饰器

### 两种权限模型

#### 1. 字符串权限 — @Permissions

```typescript
@Controller('orders')
export class OrderController {
  @Post()
  @Permissions('order:add')
  async create() { ... }

  @Get()
  @Permissions('order:query')
  async findAll() { ... }

  // 空 @Permissions() 表示只需要登录
  @Get('my')
  @Permissions()
  async findMine() { ... }
}
```

#### 2. 资源-动作模型 — @Resource + @Action

```typescript
@Controller('orders')
@Resource({ id: 'order', name: '订单管理' })
export class OrderController {
  @Post()
  @CreateAction()  // 等价于 @Action({ action: 'add', name: '新增' })
  async create() { ... }

  @Get()
  @QueryAction()
  async findAll() { ... }

  @Patch(':id')
  @UpdateAction()
  async update() { ... }

  @Delete(':id')
  @DeleteAction()
  async delete() { ... }

  @Post(':id/approve')
  @Action({ action: 'approve', name: '审批', description: '审批订单' })
  async approve() { ... }
}
```

两种模型最终都生成 `resourceId:action` 格式的权限标识进行检查。

### 公开端点

```typescript
@Public()
@Get('health')
async healthCheck() { ... }
```

### 获取当前用户

```typescript
@Get('profile')
async getProfile(@CurrentUser() user: AuthUser) {
  return user;
}

@Get('my-id')
async getMyId(@CurrentUser('id') userId: string) {
  return userId;
}
```

### 数据权限

```typescript
// 自动检查资源所有权（userId 字段匹配）
@Patch(':id')
@DataPermission('order')
async update(@Param('id') id: string, @Body() data: any) { ... }

// 跳过数据权限检查
@Get(':id')
@SkipDataPermission()
async findOne(@Param('id') id: string) { ... }
```

数据权限检查逻辑：
1. 检查资源的 `userId` 是否等于当前用户 ID（所有权检查）
2. 通过 DimensionProvider 检查维度权限
3. 检查显式数据权限配置

---

## 树形 CRUD（TreeService）

对于树形结构数据，使用 `TreeService` 替代 `BaseService`：

```typescript
import { Injectable, Inject } from '@nestjs/common';
import { TreeService } from '@zucker/crud';
import { DATABASE_ADAPTER, DynamicQueryService } from '@zucker/crud';
import { DatabaseAdapter, TreeSortSupportEntity } from '@zucker/core';

interface Category extends TreeSortSupportEntity {
  name: string;
}

@Injectable()
export class CategoryService extends TreeService<Category> {
  constructor(
    @Inject(DATABASE_ADAPTER) db: DatabaseAdapter,
    dynamicQuery: DynamicQueryService,
  ) {
    super(db, dynamicQuery, 'category');
  }
}
```

TreeService 额外提供：

| 方法 | 说明 |
|------|------|
| `findAsTree()` | 查询所有数据并组装为树形结构 |
| `findChildren(parentId)` | 查询直接子节点 |
| `findWithChildren(id)` | 查询节点及其所有后代 |
| `rebuildPath()` | 重建所有节点的 path 和 level |
| `moveNode(id, newParentId)` | 移动节点到新的父节点 |

---

## 添加新的通知通道

实现 `NotifierProvider` 接口：

```typescript
import { Injectable } from '@nestjs/common';
import { NotifierProvider, NotifyChannel, NotifyMessage } from '@zucker/notification';

@Injectable()
export class SlackProvider implements NotifierProvider {
  channel = NotifyChannel.WEBHOOK; // 或自定义 channel

  async send(message: NotifyMessage): Promise<void> {
    // 实现 Slack 发送逻辑
    await fetch(this.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: message.content }),
    });
  }
}
```

注册到通知模块：

```typescript
ZuckerNotificationModule.forRoot({
  providers: [SlackProvider],
})
```

---

## 添加新的 AI Provider

实现 `AIProvider` 接口并注册：

```typescript
import { Injectable, OnModuleInit } from '@nestjs/common';
import { AIProvider, AIModelConfig, AIProviderManager } from '@zucker/ai';

@Injectable()
export class ClaudeProvider implements AIProvider, OnModuleInit {
  id = 'claude';
  name = 'Anthropic Claude';

  constructor(private readonly providerManager: AIProviderManager) {}

  onModuleInit() {
    this.providerManager.register(this);
  }

  createModel(config: AIModelConfig): unknown {
    // 返回 LangChain 或其他 SDK 的模型实例
    return new ChatAnthropic({
      apiKey: config.apiKey,
      model: config.modelId,
      temperature: config.temperature,
      maxTokens: config.maxTokens,
    });
  }
}
```

使用 AI 调用：

```typescript
import { AIProviderManager, AIConfigService, AICallWrapper } from '@zucker/ai';

@Injectable()
export class SummaryService {
  constructor(
    private readonly providerManager: AIProviderManager,
    private readonly configService: AIConfigService,
    private readonly callWrapper: AICallWrapper,
  ) {}

  async summarize(text: string): Promise<string> {
    const config = await this.configService.getScenarioConfig('text-summary');
    const provider = this.providerManager.getDefault();
    const model = provider.createModel(config);

    return this.callWrapper.callWithRetry(
      async () => {
        // 调用模型
        const result = await model.invoke([{ role: 'user', content: `总结: ${text}` }]);
        return result.content;
      },
      { timeoutMs: 30_000, maxAttempts: 2, context: '文本摘要' },
    );
  }
}
```
