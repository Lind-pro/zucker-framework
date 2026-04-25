# 快速开始

本指南帮助你从零创建一个基于 zucker-framework 的全栈项目。

## 前置要求

- **Node.js** 20+
- **pnpm** 9+
- **PostgreSQL** 15+
- **Redis**（可选，用于缓存和分布式锁）

## 创建新项目

### 1. 从模板复制

```bash
# 克隆框架仓库
git clone https://github.com/your-org/zucker-framework.git

# 复制 server 模板到你的项目
cp -r zucker-framework/templates/server my-project
cd my-project
```

### 2. 安装依赖

在 `package.json` 中添加 @zucker 依赖：

```json
{
  "dependencies": {
    "@zucker/core": "latest",
    "@zucker/common": "latest",
    "@zucker/event": "latest",
    "@zucker/crud": "latest",
    "@zucker/auth": "latest",
    "@zucker/logging": "latest",
    "@zucker/config": "latest",
    "@zucker/cache": "latest",
    "@nestjs/common": "^10.0.0",
    "@nestjs/core": "^10.0.0",
    "@nestjs/event-emitter": "^2.0.0",
    "@prisma/client": "^5.0.0",
    "eventemitter2": "^6.4.0"
  }
}
```

```bash
pnpm install
```

### 3. 配置数据库

创建 `prisma/schema.prisma`：

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

// 业务模型示例
model Article {
  id        String   @id @default(cuid())
  title     String
  content   String?
  status    String   @default("draft")
  userId    String?
  creatorId String?
  modifierId String?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}
```

创建 `.env` 文件：

```env
DATABASE_URL="postgresql://user:password@localhost:5432/mydb"
JWT_SECRET="your-jwt-secret"
```

初始化数据库：

```bash
npx prisma migrate dev --name init
npx prisma generate
```

### 4. 配置 AppModule

模板中的 `app.module.ts` 已包含标准配置：

```typescript
import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ZuckerEventModule } from '@zucker/event';
import { ZuckerCommonModule } from '@zucker/common';
import { ZuckerCrudModule, PrismaAdapter } from '@zucker/crud';
import { ZuckerAuthModule } from '@zucker/auth';
import { ZuckerLoggingModule } from '@zucker/logging';
import { ZuckerConfigModule } from '@zucker/config';
import { ZuckerCacheModule } from '@zucker/cache';

@Module({
  imports: [
    // Layer 1: 基础
    EventEmitterModule.forRoot(),
    ZuckerEventModule.forRoot(),
    ZuckerCommonModule,

    // Layer 2: 框架核心
    ZuckerCrudModule.forRoot({ adapterClass: PrismaAdapter }),
    ZuckerAuthModule.forRoot({ jwtSecret: process.env.JWT_SECRET || 'change-me' }),
    ZuckerLoggingModule.forRoot(),

    // Layer 3: 基础设施
    ZuckerConfigModule.forRoot(),
    ZuckerCacheModule.forRoot({ provider: 'memory' }),

    // 业务模块在此添加
    // ArticleModule,
  ],
})
export class AppModule {}
```

## 创建第一个业务模块：Article CRUD

### 1. 创建 ArticleService

```typescript
// src/article/article.service.ts
import { Injectable } from '@nestjs/common';
import { BaseService } from '@zucker/crud';

interface Article {
  id: string;
  title: string;
  content: string | null;
  status: string;
  userId: string | null;
  creatorId: string | null;
  modifierId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class ArticleService extends BaseService<Article> {
  constructor(
    @Inject(DATABASE_ADAPTER) db: DatabaseAdapter,
    dynamicQuery: DynamicQueryService,
  ) {
    super(db, dynamicQuery, 'article');
  }

  // 扩展业务方法
  async publish(id: string): Promise<Article> {
    return this.update(id, { status: 'published' } as Partial<Article>);
  }
}
```

BaseService 自动提供以下方法：
- `create(data)` — 创建记录（自动触发实体事件）
- `update(id, data)` — 更新记录
- `delete(id)` — 删除记录
- `findOne(id)` — 查询单条
- `findAll(query)` — 分页查询（支持动态过滤、排序）
- `saveOrUpdate(data)` — 有 id 则更新，无则创建
- `createMany(data[])` — 批量创建
- `softDelete(id)` / `restore(id)` — 软删除/恢复
- `transaction(fn)` — 事务操作

### 2. 创建 ArticleController

```typescript
// src/article/article.controller.ts
import { Controller, Post, Param } from '@nestjs/common';
import { BaseController } from '@zucker/crud';
import { Permissions } from '@zucker/auth';
import { AccessLogger } from '@zucker/logging';
import { ArticleService } from './article.service';

// 实体类（用于 Swagger 文档）
class Article {
  id: string;
  title: string;
  content: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

@Controller('articles')
export class ArticleController extends BaseController(Article) {
  constructor(private readonly articleService: ArticleService) {
    super(articleService);
  }

  // 自动继承的标准 CRUD 端点：
  // POST   /articles          (create)
  // GET    /articles           (findAll - 分页)
  // GET    /articles/:id       (findOne)
  // PATCH  /articles/save      (saveOrUpdate)
  // PATCH  /articles/:id       (update)
  // DELETE /articles/:id       (delete)
  // POST   /articles/batch     (createMany)
  // PUT    /articles/batch     (updateMany)
  // DELETE /articles/batch     (deleteMany)

  // 扩展业务端点
  @Post(':id/publish')
  @Permissions('article:publish')
  @AccessLogger('发布文章')
  async publish(@Param('id') id: string) {
    return this.articleService.publish(id);
  }
}
```

### 3. 创建 ArticleModule

```typescript
// src/article/article.module.ts
import { Module } from '@nestjs/common';
import { ArticleService } from './article.service';
import { ArticleController } from './article.controller';

@Module({
  controllers: [ArticleController],
  providers: [ArticleService],
  exports: [ArticleService],
})
export class ArticleModule {}
```

### 4. 注册到 AppModule

```typescript
// app.module.ts
import { ArticleModule } from './article/article.module';

@Module({
  imports: [
    // ... 框架模块
    ArticleModule,
  ],
})
export class AppModule {}
```

### 5. 运行和测试

```bash
# 启动服务
pnpm dev

# 测试 API
# 创建文章
curl -X POST http://localhost:3000/articles \
  -H "Content-Type: application/json" \
  -d '{"title": "Hello World", "content": "这是第一篇文章"}'

# 查询列表（支持动态过滤）
curl "http://localhost:3000/articles?page=1&pageSize=10"

# 带过滤条件查询
curl "http://localhost:3000/articles?filters=%7B%22title%24like%22%3A%22Hello%22%7D"

# 查询单条
curl http://localhost:3000/articles/{id}

# 更新
curl -X PATCH http://localhost:3000/articles/{id} \
  -H "Content-Type: application/json" \
  -d '{"title": "Updated Title"}'

# 删除
curl -X DELETE http://localhost:3000/articles/{id}
```

## 前端集成

### Admin 后台（Ant Design）

从 `templates/admin/` 复制，安装前端包：

```json
{
  "dependencies": {
    "@zucker/fe-http-client": "latest",
    "@zucker/fe-storage": "latest",
    "@zucker/fe-auth": "latest",
    "@zucker/fe-permission": "latest",
    "antd": "^5.0.0",
    "react": "^19.0.0"
  }
}
```

使用 HTTP 客户端调用 API：

```typescript
import { httpClient, get, post } from '@zucker/fe-http-client';

// 响应自动解包，直接返回业务数据
const articles = await get<PaginatedResult<Article>>('/articles');
const article = await post<Article>('/articles', { title: 'New Article' });
```

使用认证状态管理：

```typescript
import { useAuthStore } from '@zucker/fe-auth';

const { user, login, logout } = useAuthStore();
```

使用权限控制：

```typescript
import { usePermission } from '@zucker/fe-permission';

const { hasPermission } = usePermission();

// 检查权限
if (hasPermission('article:add')) {
  // 显示创建按钮
}
```

### Web 前台（Next.js）

从 `templates/web/` 复制，支持 i18n + SEO：

```json
{
  "dependencies": {
    "@zucker/fe-http-client": "latest",
    "@zucker/fe-storage": "latest",
    "@zucker/fe-analytics": "latest",
    "next": "^15.0.0",
    "next-intl": "^3.0.0"
  }
}
```

## 下一步

- 阅读 [模块扩展指南](./extending-modules.md) 了解如何添加更多业务功能
- 阅读 [API 参考](./api-reference.md) 查看每个包的完整接口
- 如果从 hsweb/Java 迁移，查看 [hsweb 映射表](./hsweb-mapping.md)
