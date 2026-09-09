# Known Issues

> 已发现但未必当下修复的问题登记表。每项要么有 commit 引用（已修），要么有 owner / 时间预估（待修）。
>
> 修复后**不要删除条目**，标 `RESOLVED` + commit hash，方便回溯。

## 进行中

（无）



### 2026-05-13 · @zucker-framework/cli 拖崩 `pnpm -r --parallel dev`
- **症状**：根目录跑 `pnpm -r --parallel dev` 立即 `ELIFECYCLE` exit。
- **根因（两层）**：
  1. cli 的 `dev` 脚本是 `tsx src/index.ts`，直接跑 CLI 入口，无参数时 commander 打 help 然后 `process.exit(1)`，拖整个并行命令崩。
  2. `--banner.js` 在 tsup 8.x 已移除，build 也会挂。
- **修复**：删除 cli 的 `dev` 脚本（其他库包本来就没 dev）；shebang 直接写进 `src/index.ts` 头部让 tsup 自动保留。
- **Commit**：`e1bcbbb`（eea481e 是失败的中间尝试）

### 2026-05-13 · @Global() dynamic forRoot 漏写 `global: true` → 一连串 DI 失败（系统性）
- **症状**：`templates/server` 启动时 `UnknownDependenciesException` 接二连三：
  `AccessLoggerInterceptor (Reflector, EventEmitter, …)`、
  `ConfigService (DATABASE_ADAPTER, EventEmitter, …)`、
  `RateLimitGuard (Reflector, …)` —— 每次指向不同 module，但都是"应当全局可用"的
  token 在子容器里找不到。
- **根因**：20 个模块用 `@Global() @Module({})` 类装饰器 + `static forRoot()`
  返回 DynamicModule 的模式，但 forRoot 返回对象漏写 `global: true`。
  NestJS 文档明确：`@Global()` 装饰器只让类装饰器声明的（空）providers 全局；
  dynamic 部分必须在返回对象里加 `global: true` 才会被加入 GlobalsContainer，
  否则在 dynamic module 的子容器里 resolve 时连根容器的 built-in providers
  （如 `Reflector`、被 `EventEmitterModule.forRoot()` 注册的 `EventEmitter2`）也看不到。
- **修复**：
  1. 批量给所有 `@Global() forRoot()/forRootAsync()` 返回对象加 `global: true`
     （19 个文件、33 个 return block，commit `<本次>`）
  2. 同时把 `EventEmitter2` / `Reflector` 等非必需依赖改 `@Optional()`，
     host app 没注册 EventEmitterModule 时也能启动（commit `60bb162`）
- **验证**：`templates/server` 启动到 `Nest application successfully started`，
  0 个 UnknownDependenciesException。
- **Commit**：`60bb162`（Optional 改造） + `<本次 commit>`（批量 global: true）
