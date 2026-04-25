# 新增模块使用指南

> 本文档覆盖四轮架构改进中新增的 32 个模块，按使用场景组织。

---

## 1. 请求上下文 — `RequestContext`

**包**: `@zucker/common`

在整个请求链路中共享上下文（用户、租户、correlationId），无需逐层传参。

```ts
// app.module.ts — 注册中间件
import { RequestContextMiddleware } from '@zucker/common';

export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}

// 任意 Service 中使用
import { RequestContext } from '@zucker/common';

@Injectable()
export class OrderService {
  async create(data: CreateOrderDto) {
    const ctx = RequestContext.current();
    data.creatorId = ctx?.user?.id;
    data.tenantId = ctx?.tenantId;
    // correlationId 自动传播到日志
  }
}
```

---

## 2. 统一事件总线 — `UnifiedEventBus`

**包**: `@zucker/event`

替代分散的 EventEmitter2 + TopicEventBus，一个接口搞定本地 + 集群事件。

```ts
import { UnifiedEventBus } from '@zucker/event';

@Injectable()
export class OrderService {
  constructor(private readonly eventBus: UnifiedEventBus) {}

  async create(data) {
    const order = await this.db.create(data);
    // 本地 + 集群广播
    await this.eventBus.publish('order/created', { order });
    return order;
  }
}

// 订阅者（另一个服务）
@Injectable()
export class NotifyService implements OnModuleInit {
  constructor(private readonly eventBus: UnifiedEventBus) {}

  onModuleInit() {
    this.eventBus.subscribe('order/**', async (event) => {
      await this.sendNotification(event.payload);
    });
  }
}
```

---

## 3. 操作 Hook — `OperationHookRegistry`

**包**: `@zucker/event`

在任意业务操作前后注入逻辑（审批、校验、日志），不限于 CRUD。

```ts
import { OperationHookRegistry } from '@zucker/event';

const hooks = new OperationHookRegistry();

// 注册：上传前校验文件大小
hooks.register('storage.upload', 'before', (ctx) => {
  const file = ctx.data as { size: number };
  if (file.size > 50 * 1024 * 1024) {
    ctx.cancel('文件不能超过 50MB');
  }
}, { priority: 10, name: 'file-size-check' });

// 注册：上传后记录审计
hooks.register('storage.*', 'after', (ctx) => {
  auditLogger.log({ action: ctx.operation, actor: currentUser, target: ctx.result });
});

// 使用
async function uploadFile(file) {
  const ctx = hooks.createContext('storage.upload', file);
  await hooks.executeBefore(ctx);
  if (ctx.cancelled) throw new Error(ctx.cancelReason);

  const result = await storage.save(file);
  ctx.result = result;
  await hooks.executeAfter(ctx);
  return result;
}
```

---

## 4. 错误分类器 — `classifyError` / `withRetry`

**包**: `@zucker/core`

自动识别 Prisma 错误码、超时、连接问题，决定是否可重试。

```ts
import { classifyError, withRetry } from '@zucker/core';

// 方式一：手动分类
try {
  await db.user.create({ data });
} catch (error) {
  const cls = classifyError(error);
  if (cls.code === 'UNIQUE_CONSTRAINT') {
    throw new ConflictException('用户名已存在');
  }
  throw cls.cause;
}

// 方式二：自动重试（仅对可重试错误）
const user = await withRetry(
  () => externalApi.getUser(id),
  3, // 最多重试 3 次
);
```

---

## 5. 断路器 — `CircuitBreaker`

**包**: `@zucker/core`

保护外部服务调用，连续失败后自动熔断。

```ts
import { CircuitBreaker, CircuitOpenError } from '@zucker/core';

const emailBreaker = new CircuitBreaker({
  name: 'email-service',
  failureThreshold: 5,
  resetTimeoutMs: 30_000,
  onStateChange: (from, to) => console.log(`Email circuit: ${from} → ${to}`),
});

async function sendEmail(msg) {
  try {
    return await emailBreaker.execute(() => emailProvider.send(msg));
  } catch (e) {
    if (e instanceof CircuitOpenError) {
      // 降级：放入队列稍后重试
      await queue.add('email', msg);
      return { queued: true };
    }
    throw e;
  }
}
```

---

## 6. 类型安全配置 — `defineConfig` / `mergeConfigs`

**包**: `@zucker/core`

用 Zod 定义配置 schema，同时获得运行时验证和 TypeScript 类型推断。

```ts
import { z } from 'zod/v4';
import { defineConfig, mergeConfigs, loadFromEnv, safeParseConfig } from '@zucker/core';

const AppConfig = defineConfig({
  port: z.number().default(3000),
  database: z.object({
    url: z.string().url(),
    maxConnections: z.number().default(10),
  }),
  jwt: z.object({
    secret: z.string().min(16),
    expiresIn: z.string().default('7d'),
  }),
});

// 分层合并（后者覆盖前者）
const defaults = { port: 3000, database: { maxConnections: 5 } };
const envOverrides = loadFromEnv('APP'); // APP__DATABASE__URL=... → { database: { url: ... } }
const merged = mergeConfigs(defaults, envOverrides);

// 安全解析（不抛异常）
const result = safeParseConfig(AppConfig, merged);
if (!result.success) {
  console.error('配置错误:', result.errors);
  process.exit(1);
}
const config = result.data; // 完全类型安全
```

---

## 7. Feature Flag — `FeatureFlagService`

**包**: `@zucker/config`

渐进发布功能，支持环境变量覆写、百分比灰度、白名单/黑名单。

```ts
import { FeatureFlagService } from '@zucker/config';

const flags = new FeatureFlagService();

flags.registerAll([
  {
    key: 'new_dashboard',
    defaultValue: false,
    rules: [
      { type: 'allowlist', values: ['tenant-vip', 'admin'] },  // VIP 和管理员始终看到
      { type: 'percentage', percentage: 20 },                    // 其余用户 20% 灰度
    ],
  },
  {
    key: 'dark_mode',
    defaultValue: true,
    rules: [
      { type: 'blocklist', values: ['legacy-tenant'] },  // 旧租户不启用
    ],
  },
]);

// 评估
if (flags.isEnabled('new_dashboard', { userId: 'u1', tenantId: 't1' })) {
  // 展示新仪表盘
}

// 环境变量覆写（测试用）：FF_NEW_DASHBOARD=true 强制开启
// 用户级覆写：
flags.setUserOverride('new_dashboard', 'tester-1', true);
```

---

## 8. 缓存标签失效 — `TaggedCache`

**包**: `@zucker/cache`

按业务维度批量清除缓存，不再需要知道具体的缓存 key。

```ts
import { TaggedCache, MemoryCache } from '@zucker/cache';

const cache = new TaggedCache(new MemoryCache());

// 设置缓存并打标签
await cache.setWithTags('user:123:profile', profile, ['user:123', 'profile']);
await cache.setWithTags('user:123:orders', orders, ['user:123', 'order']);
await cache.setWithTags('user:456:profile', other, ['user:456', 'profile']);

// 用户 123 修改了信息 → 清除该用户所有缓存
await cache.invalidateByTag('user:123');
// 清除了 user:123:profile 和 user:123:orders，user:456:profile 不受影响

// 所有用户 profile 缓存需要刷新
await cache.invalidateByTag('profile');
```

---

## 9. 审计日志 — `AuditLogger`

**包**: `@zucker/logging`

记录敏感操作的不可变审计追踪。

```ts
import { AuditLogger } from '@zucker/logging';

const audit = new AuditLogger();

// 记录角色分配
await audit.log({
  action: 'permission.grant',
  actor: { id: 'admin-1', type: 'user', name: '管理员' },
  target: { type: 'user', id: 'user-42', name: '张三' },
  changes: {
    roles: { before: ['viewer'], after: ['viewer', 'editor'] },
  },
  reason: '用户晋升为编辑',
});

// 查询审计日志
const logs = await audit.query({
  actorId: 'admin-1',
  startTime: Date.now() - 86400_000, // 最近 24 小时
});
```

---

## 10. PII 过滤器 — `PiiFilter`

**包**: `@zucker/logging`

自动识别和脱敏日志中的个人信息。

```ts
import { PiiFilter } from '@zucker/logging';

const filter = new PiiFilter();

// 字符串脱敏
filter.sanitize('用户邮箱 test@example.com，手机 13800138000');
// → '用户邮箱 [EMAIL]，手机 [PHONE]'

// 对象深度脱敏
filter.sanitizeObject({
  name: '张三',
  email: 'test@example.com',
  password: 'secret123',    // 敏感字段 → [REDACTED]
  token: 'eyJhbGciOiJ...',  // JWT → [JWT]
});
```

---

## 11. 优雅停机 — `GracefulShutdownManager`

**包**: `@zucker/common`

按阶段顺序关闭资源，避免数据丢失。

```ts
import { GracefulShutdownManager } from '@zucker/common';

@Injectable()
export class QueueService {
  constructor(private shutdown: GracefulShutdownManager) {
    shutdown.register(0, () => this.queue.pause(), 'pause-queue');
    shutdown.register(1, () => this.queue.drain(), 'drain-queue');
  }
}

@Injectable()
export class DbService {
  constructor(private shutdown: GracefulShutdownManager) {
    shutdown.register(3, () => this.connection.close(), 'close-db');
  }
}
```

---

## 12. Webhook 可靠投递 — `WebhookRegistry`

**包**: `@zucker/notification`

```ts
import { WebhookRegistry } from '@zucker/notification';

const registry = new WebhookRegistry();

// 注册
registry.register({
  id: 'wh-1',
  url: 'https://partner.com/webhook',
  events: ['order.created', 'order.paid'],
  secret: 'webhook-secret-key',
});

// 触发
await registry.dispatch('order.created', { orderId: '123', amount: 99 });
// 自动: HMAC 签名 → 投递 → 5xx 重试 → 记录投递状态

// 验证入站 webhook
const isValid = WebhookRegistry.verify(body, signature, secret);
```

---

## 13. 后台任务 — `TaskLifecycleManager`

**包**: `@zucker/queue`

```ts
import { TaskLifecycleManager } from '@zucker/queue';

const tasks = new TaskLifecycleManager();

const taskId = tasks.submit({
  name: 'export-csv',
  handler: async (ctx) => {
    for (let i = 0; i < batches.length; i++) {
      if (ctx.isCancelled()) return;
      await process(batches[i]);
      ctx.updateProgress((i + 1) / batches.length, `处理第 ${i + 1} 批`);
    }
    return { file: '/exports/data.csv' };
  },
  timeoutMs: 60_000,
  maxRetries: 2,
});

// 查询状态
const info = tasks.getTask(taskId);
// → { status: 'running', progress: 0.6, progressMessage: '处理第 3 批' }

// 取消
tasks.kill(taskId);

// 查看失败任务（死信队列）
const dlq = tasks.getDeadLetterQueue();
```

---

## 14. 流式管道 — `mapStream` / `batchStream` / ...

**包**: `@zucker/core`

可组合的 AsyncGenerator 工具，用于大数据处理。

```ts
import { mapStream, filterStream, batchStream, collectStream } from '@zucker/core';

// 数据源（假设是分页查询）
async function* fetchUsers() {
  let page = 1;
  while (true) {
    const batch = await userService.findAll({ page, pageSize: 100 });
    if (batch.data.length === 0) break;
    for (const user of batch.data) yield user;
    page++;
  }
}

// 组合管道：过滤 → 转换 → 分批
const pipeline = batchStream(
  mapStream(
    filterStream(fetchUsers(), user => user.status === 'active'),
    user => ({ id: user.id, name: user.name, email: user.email }),
  ),
  500,  // 每 500 条一批
);

for await (const batch of pipeline) {
  await csvWriter.writeRows(batch);
}
```

---

## 15. VCR 测试固件 — `withVcrFixture`

**包**: `@zucker/core`

录制外部 API 响应，后续测试直接回放，无需网络。

```ts
import { withVcrFixture } from '@zucker/core';

it('should fetch user profile', async () => {
  const profile = await withVcrFixture(
    'user-profile',
    { userId: '123' },
    () => apiClient.getProfile('123'),
  );
  expect(profile.name).toBe('张三');
});
// 首次运行：调用真实 API，保存到 __fixtures__/user-profile-<hash>.json
// 后续运行：直接从文件读取
// CI 中设置 VCR_RECORD=1 重新录制
```

---

## 16. Mailbox 消息路由 — `Mailbox`

**包**: `@zucker/core`

Actor 模式的消息邮箱，用于异步协调。

```ts
import { Mailbox } from '@zucker/core';

const approvals = new Mailbox<{ orderId: string; approved: boolean }>();

// 发起审批请求
async function requestApproval(orderId: string) {
  notifyApprover(orderId);

  // 阻塞等待审批结果（30 秒超时）
  const result = await approvals.receive(
    msg => msg.orderId === orderId,
    30_000,
  );
  return result.approved;
}

// 审批者回调
function onApprovalResponse(orderId: string, approved: boolean) {
  approvals.send({ orderId, approved });
}
```

---

## 17. 数据迁移 — `MigrationRunner`

**包**: `@zucker/core`

幂等的业务数据迁移框架。

```ts
import { MigrationRunner, type MigrationDefinition } from '@zucker/core';

const migrations: MigrationDefinition[] = [
  {
    id: '20240401_unify_roles',
    description: '合并重复角色',
    condition: async (db) => {
      const dupes = await db.model('roles').count({ where: { name: 'admin' } });
      return dupes > 1;
    },
    execute: async (db) => {
      // 迁移逻辑...
    },
  },
];

const runner = new MigrationRunner(db);

// Dry run
const check = await runner.check(migrations);
// → [{ id: '20240401_unify_roles', needsRun: true }]

// 执行
const results = await runner.run(migrations);
// → [{ id: '20240401_unify_roles', status: 'executed', durationMs: 123 }]
```

---

## 18. 配置热重载 — `ConfigFileWatcher`

**包**: `@zucker/config`

```ts
import { ConfigFileWatcher } from '@zucker/config';

const watcher = new ConfigFileWatcher({ stabilityMs: 1000 });

watcher.watch('/etc/app/config.json', () => {
  configService.clearCache();
  logger.log('配置已重载');
});

// 应用关闭时
watcher.close();
```

---

## 19. CRUD 自动生成 — `CrudControllerFactory`

**包**: `@zucker/crud`

消除重复的 Controller 代码。

```ts
import { Controller, Inject } from '@nestjs/common';
import { CrudControllerFactory } from '@zucker/crud';
import { UserService } from './user.service';

@Controller('admin/users')
export class UsersController extends CrudControllerFactory(UserService, {
  routes: {
    delete: { enabled: true },
  },
  softDelete: true,
}) {
  constructor(@Inject(UserService) service: UserService) {
    super(service);
  }

  // 自动拥有: POST /_query, GET /:id, POST /, PUT /:id, DELETE /:id
  // 只需手写非标准端点
}
```
