# Zucker Framework 全包审阅（2026-11-16）

审阅基准：`aee88b9bcd0b4f4bd181ac3b7116897f70af63d2` 加上审阅开始时已有的未提交修改。结论针对当前工作区源码，不等同于已发布的 1.0.21 制品。初次审阅仅新增文档与复现用例；随后按用户授权完成 11 类问题的本地修复，详见 [修复与验证记录](./fixes.md)。下文问题描述、行号和 evidence.json 保留修复前基准。

确认 **11 类可修复问题：1 项 P1、10 项 P2**。优先修复跨账号请求重放，其次处理取消传播、资源销毁和缓存一致性。各项均有独立合成数据复现；完整计数与源码摘要见 [evidence.json](./evidence.json)，57 包覆盖矩阵见 [coverage.md](./coverage.md)。

## 范围与证据边界

- 全量扫描 57 个包的 manifest、exports 和 1,000 个非 `*.spec.*` / `*.test.*` 源码文件的实际 import/export/动态加载语句；该计数包含少量测试辅助代码。声明的内部运行时/peer 依赖图无环。扫描命中的未声明依赖仅为 `fe-admin/src/test/harness.tsx` 使用根工作区测试依赖，未作为运行时缺陷报告。
- 运行 `packages` 下全部现有 Vitest 用例：556 个测试文件，**6,340 通过、125 跳过、0 失败**。另运行 ext-kit 的 engine/licensing/lifecycle 与 CLI 入口 Node 测试：**46 通过**。首批 84 项定向回归已包含在全包结果中，不重复计数。
- 结合实际调用方深入检查会话、事务、任务恢复、资源生命周期、流、缓存与存储。不是对每一行代码的形式化正确性证明；“本轮无新增确认问题”也不表示该包不存在缺陷。
- 本轮新增 **14 个缺陷特征用例**，全部通过意味着下述错误行为被重现，**不表示问题已修复**。这是初次审阅的历史结果。修复后已反转断言并迁移到所属包，当前独立入口运行修复后的回归；原用例保存在 [历史复现文本](./reproduce.before-fix.ts.txt)。
- 未提供专用数据库/缓存地址，因此显式移除 `TEST_DATABASE_URL`、`TEST_REDIS_URL`、`AI_ACCESS_POSTGRES_TEST_URL`、`S3_MINIO_ENDPOINT` 后执行。未验证真实 PostgreSQL 并发、Redis、MinIO 或外部支付/AI 服务；部分测试使用 PGlite。125 个跳过项还包括测试文件自身标记的跳过用例。
- 未运行生产构建、制品打包、发布门禁、浏览器 E2E。Vitest 使用源码 alias；通过结果不能证明 `dist`、导出制品和发布后的 peer 实例身份正确。

## 确认问题

### R01 · P1 · 切换账号后，旧请求被新账号的凭据重新发送

位置：[fe-http-client/http-client.ts](../../../packages/fe-http-client/src/http-client.ts)，458–459、468–478 行；重试调用在 310–318 行，`fetchStream` 也复用相同刷新逻辑。

触发：账号 A 的 POST 已发出但返回 401 前切换成 B，或在 A 的 refresh 等待期间切换成 B。代码只要发现 token 已变化，就把当前 token 当成有效重试凭据返回，没有证明它仍属于原会话。随后原 URL、method、body 被原样重放。

证据：两个时序中，同一个 `/profile` POST 均依次携带 `Bearer account-A`、`Bearer account-B`；第二次 body 仍是 A 的修改内容。账号级的更新、创建或其他写入因此可能错误作用于 B。

建议：请求发起时绑定稳定的会话标识或会话代次；重试前、取得跨标签页锁后和 refresh 结束后都验证该标识。允许同会话 token 轮换，跨会话则取消请求。共享 refresh 的调用者也应逐个检查会话，不能只检查 token 字符串。

调用方边界：当前 Web 的 `accountRequestSignal` 和 fe-admin 的 `bindApi` 已绑定会话取消，能缓解此风险；本轮没有证明这些模板的普通操作发生跨账号写入。缺陷影响直接使用公开 `HttpClient`、没有额外绑定会话取消的消费者；`acceptResponseToken` 只控制响应头采纳，不能保护这条重试路径。

### R02 · P2 · LocaleInterceptor 丢失上游订阅的取消传播

位置：[i18n/locale-context.ts](../../../packages/i18n/src/locale-context.ts)，67–83 行。

触发：用 LocaleInterceptor 包装持续 Observable/SSE，然后客户端断开或外层取消。拦截器在新 Observable 内手动 subscribe，却没有返回 teardown，也没有把内部订阅加入外层订阅。

证据：外层 `unsubscribe()` 后，合成上游订阅仍为 `closed === false`，资源清理回调没有运行。依赖 unsubscribe 停止的计时器、事件监听或上游请求会继续工作。

建议：在 ALS 上下文内创建内部订阅，返回对它的 unsubscribe；可参考当前 `TenantInterceptor` 的实现。补充完成、错误、主动取消三条路径的测试。

### R03 · P2 · NetworkManager 销毁时遗漏正在创建的网络实例

位置：[network/network-manager.ts](../../../packages/network/src/network-manager.ts)，115–123、175–182、189–207 行。

触发：`getNetwork()` 正等待异步工厂时调用 `destroy()` 或 `onModuleDestroy()`。销毁仅遍历已写入 store 的对象，不等待/废弃 `pending`，也没有关闭状态或创建代次检查。

证据：延迟工厂在销毁之后成功返回，实例的 `shutdown()` 从未被调用。单实例 destroy 后它重新进入缓存；模块销毁后它进入已脱离 store 的旧 Map，成为无法枚举的活跃对象。

建议：将创建、reload、销毁纳入同一生命周期协调；销毁先封闭新准入，再等待未完成创建并关闭其结果，或使用代次标识丢弃并释放迟到结果。补上 shutdown/reload 与健康检查的交错测试。

### R04 · P2 · DataSourceManager 的迟到 reload 复活已移除的数据源

位置：[datasource/datasource-manager.ts](../../../packages/datasource/src/datasource-manager.ts)，207–223 行。

触发：reload 读取旧配置后等待 factory，此时管理操作执行 remove/close。factory 完成后无条件 set 新 adapter，并清除 closed 标记。

证据：`reload → remove → factory resolve` 后，`has('db') === true` 且可获取新 adapter，但 `getConfigs()` 已为空。管理端已移除的数据源重新可用，且新连接池没有被释放。

建议：按数据源保存配置/生命周期代次，异步创建完成时比较；移除或更新后到达的旧结果必须释放，不能写回。对 add/reload/remove/close 的交错使用同一规则，保留现有失败不替换旧池的语义。

### R05 · P2 · 本地分块合并忽略背压，内存占用退化为整个文件大小

位置：[storage/local-storage.ts](../../../packages/storage/src/local-storage.ts)，278–285 行。

触发：合并多块较大的上传文件。循环同步读取每个 chunk，然后无条件 `writeStream.write()`；没有处理返回 false，也没有等待 drain。写端尚未获得异步执行机会，所有 chunk 就已进入缓冲。

证据：8 × 256 KiB 的真实临时分块文件合并成功，但 WriteStream 的 `writableLength` 峰值等于完整文件的 **2 MiB**。这是确定的缓冲行为，不是声称做过 GiB 级内存压测。更大文件按同样路径增长，并阻塞事件循环。

建议：用有背压的异步流/pipeline 顺序拼接，避免 `readFileSync` 整块累积；保留当前临时文件、原子 rename 和失败清理保证。需要补充慢磁盘、源读取错误、取消与大文件的内存上界回归。

### R06 · P2 · 旧 Provider 注册句柄会注销同 ID 的新 Provider

位置：[provider/provider-registry.ts](../../../packages/provider/src/provider-registry.ts)，60–67 行。

触发：同 ID 注册 A，再注册 B，随后清理 A 的 disposable。句柄只记住 ID，调用 `unregister(id)`，实际删除的是 B。

证据：B 替换 A 后查询正常；`A.dispose()` 后 registry 中该 ID 消失。此机制还被 FallbackProviderRegistry 代理使用，可能使热替换后的 provider 不可用。

建议：disposable 绑定注册代次/注册项身份，仅注销自己仍持有的注册项，并保持重复 dispose 幂等。不要仅以 ID 决定句柄所有权。

### R07 · P2 · 时序聚合把合法的零结果替换成“无数据默认值”

位置：[timeseries/memory-timeseries.ts](../../../packages/timeseries/src/memory-timeseries.ts)，158–161、177–182 行；`AggregationColumn.defaultValue` 在 types 中明确用于无数据。

触发：多列聚合配置了非零 defaultValue，而 SUM/AVG/MIN 等实际结果为 0。实现用 `val === 0` 判断是否缺数据。

证据：输入值为 `1` 和 `-1`，SUM 应为 0，设置 `defaultValue: 99` 后得到 99；有时间桶和无分组两条路径都重现。

建议：区分“有可聚合数据且结果为 0”与“没有有效值”；默认值只用于后一种情况。影响当前公开的内存时序实现，不能据此推断外部时序数据库适配器也有此问题。

### R08 · P2 · 旧会话恢复的失败会清除新登录状态

位置：[fe-auth/cookie-session.ts](../../../packages/fe-auth/src/cookie-session.ts)，226–230 行。

触发：A 的 restore 等待 refresh 时，通过公开 `adoptToken()` 完成 B 的登录；A 的旧 refresh 随后返回 401/403。成功路径检查 superseded，但 catch 路径直接 logout 当前状态。

证据：B 已进入 store，旧 restore 失败后返回 anonymous，B 的 user/token 被清空。

建议：restore 捕获会话代次，成功与失败都仅能修改该代次的状态。当前 Web sign-in 和 fe-admin 登录流程已有 `settled()` 等待，能避开这个交错；问题属于公开 CookieSession API 缺失自身保护，不是已确认的模板登录故障。

### R09 · P2 · 规则启动中途失败，已启动的触发器无法停止

位置：[rule-engine/rule-engine.service.ts](../../../packages/rule-engine/src/rule-engine.service.ts)，144–148 行。

触发：规则有多个 trigger，前面的 EVENT 已成功 subscribe，后面的 TIMER 因无效 cron 抛错。只有所有 trigger 都成功后才登记 activeRules，且没有失败回滚。

证据：startRule 拒绝，`isRuleActive()` 为 false；即使调用 `onModuleDestroy()`，先前事件监听仍在。executeRule 对不存在于 activeRules 的定义也不会直接拒绝，因此该孤立触发器仍可执行动作。

建议：启动前先验证所有配置，再以 try/catch 回滚启动过程中获得的订阅/定时器。保留并测试“启动失败没有任何活跃触发器”的不变量。

### R10 · P2 · HTTP Trace 的结束时机不匹配 Observable 生命周期

位置：[tracing/trace-interceptor.ts](../../../packages/tracing/src/trace-interceptor.ts)，41–48、49–64 行。

触发：多次发射的流在第一次 next 就执行 `span.end()`；EMPTY 正常完成、从未发射就取消的流则不经过 next/error，span 不会结束。

证据：Subject 发送第一个事件时外层仍活跃，但 span 已不再 recording；另一个没有发射就取消的流，其 span 永久保持 recording。流式请求的持续时间和完成状态因此失真。

建议：用 complete/error/finalize 管理结束，保证恰好结束一次，并保留错误状态。若目标是实际 HTTP 传输耗时，则进一步绑定响应 finish/close，而不是把 handler 的 next 视为传输完成。

### R11 · P2 · HybridCache 直接写入绕过 L1 失效上限

位置：[cache/hybrid-cache.ts](../../../packages/cache/src/hybrid-cache.ts)，38–42 行。

触发：A、B 两个实例共享 L2；A 写入 key，B 更新/删除同一个 key。`get()` 的回填会限制 L1 TTL，但 `set()` 给 L1 原样传递业务 TTL；默认 MemoryCache 在 TTL 未指定时永不过期。

证据：L1 上限配置为 60 秒，A 写 old、B 写 new，120 秒后共享 L2 为 new，A 仍返回 old。TTL 为空时该过期值可无限保留。复现使用共享 MemoryCache 作为 L2，只证明 HybridCache 的算法，未冒充 Redis 集成测试。

建议：所有 L1 写入统一遵守有限驻留上限，包括直写和回填；长 TTL/永久 L2 不应导致永久 L1。也可提供显式跨实例失效机制。修复应保留当前 sequence 操作直接读取权威 L2 的保证。

## 优化与修复顺序

1. 先修 R01，并补齐账号切换前后、并发 refresh、跨标签页锁等待中的写请求回归；保留当前消费者的会话取消机制。
2. R02/R03/R04/R09 统一落实“谁创建谁释放、迟到结果不能复活已关闭资源”，但优先修各自现有实现；无需立即新建共享包。
3. R11 明确缓存失效上界，R05 实施有背压的合并。两项都应以可测的上界验证，避免单纯调整默认数字。
4. 处理 R06/R07/R08/R10，并把复现转换成正常回归测试。provider/timeseries 当前默认套件分别只有 3/2 项用例，值得优先补充替换、边界值与空数据场景，而非增加大量镜像实现的测试。

## 重现命令

在仓库根目录执行：

```sh
env -u TEST_DATABASE_URL -u TEST_REDIS_URL -u AI_ACCESS_POSTGRES_TEST_URL -u S3_MINIO_ENDPOINT pnpm exec vitest run packages --maxWorkers=4
node --test packages/ext-kit/test/engine.test.cjs packages/ext-kit/test/licensing.test.cjs packages/ext-kit/test/lifecycle.test.cjs scripts/cli-entry.test.mjs
pnpm exec vitest run --config docs/reviews/2026-11-16-package-review/vitest.config.ts
```

最后一条现在运行所属包的修复回归，不再断言错误行为。审阅过程中的首次复现运行修正了审阅夹具的依赖解析、POST 参数位置和流监测方式，未因此修改任何包源码。

## 迁移与回滚

修复没有数据库迁移或依赖替换。新增可选 `HttpClientConfig.sessionKey`，Web/fe-admin 源码已接线；迁移、行为变化和回滚边界见 [修复记录](./fixes.md)。未构建、提交、发布或部署，源码回归不表示发布制品已经交付。
