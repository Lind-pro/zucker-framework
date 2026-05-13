# Known Issues

> 已发现但未必当下修复的问题登记表。每项要么有 commit 引用（已修），要么有 owner / 时间预估（待修）。
>
> 修复后**不要删除条目**，标 `RESOLVED` + commit hash，方便回溯。

## 进行中

### `@nestjs/core` 双副本导致 DI class-token 失配（系统性）

- **症状**：templates/server 启动时一连串 `UnknownDependenciesException`：
  `AccessLoggerInterceptor (Reflector, EventEmitter, ...)`、
  `ConfigService (DATABASE_ADAPTER, EventEmitter, ...)`、
  `RateLimitGuard (Reflector, ...)` —— 每次错误指向不同 module，但都是
  `Reflector` / `EventEmitter` 等"应当全局可用"的 class token 找不到。
- **根因**：`pnpm list .pnpm/` 显示 `@nestjs+core@11.1.17` **有两个 directory**，
  peer dep 解析（带/不带 `class-validator`）不同导致 pnpm 复制成两份。
  Reflector 这种 class 用作 DI token 时，两份的 class 是不同对象 →
  NestJS 子容器找不到匹配。
- **临时修法（已应用）**：把所有 hard `EventEmitter2` / `Reflector` 依赖改成
  `@Optional()` + `?.` 访问；这样 host application 没注册 EventEmitterModule 也
  能启动，并躲过 class-identity 不一致的部分场景。
  - `packages/logging/src/access-logger.interceptor.ts`
  - `packages/logging/src/business-logger.ts`
  - `packages/config/src/config.service.ts`
  - `packages/config/src/layered-config.service.ts`
  - `packages/monitoring/src/alert/alert-manager.service.ts`
  - `packages/logging/src/logging.module.ts` 同时加 `global: true`（NestJS 文档要求 dynamic forRoot 显式声明）
- **根因修复（待办）**：
  1. 尝试 `.npmrc` `public-hoist-pattern[]=@nestjs/*` 强制 nest 包提升到根 node_modules
     （实验过但 pnpm 9.x 没生效，可能需要 root package.json 显式声明 @nestjs/core devDep 才触发提升）
  2. 或用 pnpm.overrides 全部 nest 包钉死同一版本 + 同 peer combo
  3. 或迁移到 `node-linker=hoisted`（破坏 pnpm 隔离，但 nest monorepo 普遍做法）
- **影响范围**：另有 19 个 dynamic forRoot 模块用相同 pattern，可能撞同样问题
  （已发现：`ZuckerRateLimiterModule.RateLimitGuard`）。彻底修复前每发现一个加一处 Optional。



### 2026-05-13 · @zucker/cli 拖崩 `pnpm -r --parallel dev`
- **症状**：根目录跑 `pnpm -r --parallel dev` 立即 `ELIFECYCLE` exit。
- **根因（两层）**：
  1. cli 的 `dev` 脚本是 `tsx src/index.ts`，直接跑 CLI 入口，无参数时 commander 打 help 然后 `process.exit(1)`，拖整个并行命令崩。
  2. `--banner.js` 在 tsup 8.x 已移除，build 也会挂。
- **修复**：删除 cli 的 `dev` 脚本（其他库包本来就没 dev）；shebang 直接写进 `src/index.ts` 头部让 tsup 自动保留。
- **Commit**：`e1bcbbb`（eea481e 是失败的中间尝试）

### 2026-05-13 · templates/server 启动 DI 失败 — Reflector 不可解析
- **症状**：`templates/server` 启动时
  ```
  UnknownDependenciesException: Nest can't resolve dependencies of the
  AccessLoggerInterceptor (?, EventEmitter, Symbol(ACCESS_LOG_BUS)).
  Reflector at index [0] is not available in the ZuckerLoggingModule module.
  ```
- **根因**：`ZuckerLoggingModule` 用 `@Global() @Module({})` 空壳类装饰器 + `forRoot()` 动态返回 providers。当 NestJS 实例化 `APP_INTERCEPTOR` (AccessLoggerInterceptor) 时，在该 dynamic module 的子容器里查 `Reflector`，没有继承到根容器的 built-in `Reflector`。
- **修复路径**：在 `forRoot()` providers 列表显式声明 `Reflector`，让 dynamic module 子容器能 resolve（NestJS 会复用根 singleton）。
- **Commit**：`<待填>`
