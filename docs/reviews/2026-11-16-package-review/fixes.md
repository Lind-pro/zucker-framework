# 2026-11-16 全包审阅问题修复

用户授权修复后，R01–R11 均已完成本地实现和回归。保留审阅前的未提交工作。初次运行时修复没有数据库迁移、依赖安装、生产构建、提交、发布或部署；后续测试类型修复新增一个开发类型依赖，见下节记录。

## 修复对应关系

| 问题 | 所属包 / 回归测试 | 修复行为 |
| --- | --- | --- |
| R01 | [fe-http-client](../../../packages/fe-http-client/src/package-review.regression.spec.ts) | 请求绑定会话；刷新锁前后、交换结束和重试前验证；旧错误不能清除新登录；新增可选 sessionKey。 |
| R02 | [i18n](../../../packages/i18n/src/package-review.regression.spec.ts) | 直接返回 ALS 内的订阅，正常结束、异常和取消均释放上游。 |
| R03 | [network](../../../packages/network/src/package-review.regression.spec.ts) | 按类型/ID 串行协调生命周期；关闭使在途创建/重载失效并释放结果，模块关闭拒绝新准入。 |
| R04 | [datasource](../../../packages/datasource/src/package-review.regression.spec.ts) | 异步 add/reload 比较代次；remove/close/更新后迟到结果释放，不再复活数据源。 |
| R05 | [storage](../../../packages/storage/src/package-review.regression.spec.ts) | 异步顺序读取 chunk 并用 pipeline 传播背压；保留临时文件原子替换和错误清理。 |
| R06 | [provider](../../../packages/provider/src/package-review.regression.spec.ts) | disposable 绑定注册代次；旧句柄不能注销替换项，同对象重复注册及重复 dispose 均受保护。 |
| R07 | [timeseries](../../../packages/timeseries/src/package-review.regression.spec.ts) | 默认值仅用于缺少可聚合值；合法零结果在分桶与非分桶路径保留。 |
| R08 | [fe-auth](../../../packages/fe-auth/src/package-review.regression.spec.ts) | restore 成功与失败都比较会话代次；新账号及同用户重新登录不受旧结果影响；dispose 释放监听。 |
| R09 | [rule-engine](../../../packages/rule-engine/src/package-review.regression.spec.ts) | 启动异常时回滚已取得的事件订阅和定时器；触发器在 start 前纳入清理列表。 |
| R10 | [tracing](../../../packages/tracing/src/package-review.regression.spec.ts) | 每次订阅创建 span，在 finalize 结束一次；覆盖多次发射、空完成、取消及同步/异步异常。 |
| R11 | [cache](../../../packages/cache/src/package-review.regression.spec.ts) | 直写与回填均限制有限 L1 TTL；不缩短 L2 业务 TTL；零上限关闭 L1 填充。 |

通用机制仍归原包；账号识别策略通过现有 fe-auth `jwtSessionKey` 由消费者提供，没有导入业务模型或新建共享包。

## 验证证据

- 受影响 11 包 + fe-admin 两个会话测试文件：91 个文件，**970 通过、22 跳过、0 失败**。这是最后一次受影响套件运行；随后只添加 shutdown 在途创建用例和显式空 token 保护，并完成下述最终专项回归。
- 最终专项回归入口：**42 通过、0 失败**，覆盖最初 14 个缺陷场景及相邻生命周期边界。这些用例与上项重叠，不相加。
- Web `account-session.spec.ts`：**7 通过**。使用合成账号/JWT，运行真实 store、会话保护和 HTTP 客户端，网络交换使用替身。属于本地 jsdom 运行时集成，不是浏览器 E2E。
- 分块测试真实创建 8 × 256 KiB 临时文件，验证最终 2 MiB 内容一致，写缓冲峰值不超过 128 KiB；既有源文件丢失/失败清理回归也通过。未进行 GiB 级压测。
- 8 包完整 `tsc --noEmit` 通过：fe-http-client、i18n、datasource、storage、provider、timeseries、rule-engine、cache。fe-auth/network/tracing 的源码入口和新增回归专项类型检查通过。
- 初次修复时，这 3 包的整包类型检查受未修改的旧测试阻碍：fe-auth 的 store 全局测试类型、oauth-popup 浏览器测试 Node 类型缺失；network `codec.spec.ts` 的 Buffer.isBuffer 类型；tracing `tracer.spec.ts` 的参数数量。初次未把这些整包检查记为通过；用户随后授权继续修复，现已全部通过，详见下节。
- 变更文件 ESLint 无 error，存在既有风格 warning；定向 `git diff --check` 通过。没有运行真实 PostgreSQL/Redis/MinIO/外部提供商或生产制品门禁。

可复跑命令：

```sh
env -u TEST_DATABASE_URL -u TEST_REDIS_URL -u AI_ACCESS_POSTGRES_TEST_URL -u S3_MINIO_ENDPOINT pnpm exec vitest run packages/{fe-http-client,fe-auth,i18n,network,datasource,storage,provider,timeseries,rule-engine,tracing,cache} packages/fe-admin/src/app/session-restore.spec.tsx packages/fe-admin/src/app/session.reload-on-focus.spec.tsx --maxWorkers=4
pnpm exec vitest run --config docs/reviews/2026-11-16-package-review/vitest.config.ts
pnpm exec vitest run --config vitest.web.config.ts templates/web/test/account-session.spec.ts
```

机器可读结果摘要与修复后文件哈希见 [fix-evidence.json](./fix-evidence.json)。初次审阅的 evidence.json、structure.json 和 coverage.md 保留历史基准；历史缺陷用例保存在 [reproduce.before-fix.ts.txt](./reproduce.before-fix.ts.txt)，当前 reproduce.spec.ts 调用包内回归。

## 兼容性、迁移与回滚

- 公开新增项只有可选 `HttpClientConfig.sessionKey(token)`，由既有包根导出的 HttpClientConfig 暴露。Web account client 和 fe-admin 已传入各自现有的 `jwtSessionKey(['sub', 'sid'])` 策略（fe-admin 保留可配置 claims）。令牌没有可识别 session key 时采用保守判断：访问令牌变化且不能以未变化的显式 refresh token 证明连续性，就取消旧请求。Cookie 客户端要保留跨标签页令牌轮换后的重试，应配置该回调。继续保留已有 request scope/abort signal，以及时取消在途工作并识别同凭据的退出再登录。
- `shutdown` / `destroy` / 模块销毁会等待在途网络工厂或重载完成清理；被撤销的旧 get/reload Promise 拒绝。Provider 必须为外部 I/O 设置超时，管理器不能强制取消永不结束的 Promise。显式 reload 仍可恢复 shutdown 的缓存实例。
- datasource 的 remove/close 保持同步签名。迟到 adapter 按原有 `disposeOnReplace`、`drainDelayMs` 释放；`disposeOnReplace: false` 仍表示消费者拥有连接生命周期。失败工厂不会替换当前可用连接。
- HybridCache 的 `l1BackfillTtlMs` 必须有限且非负；0 禁止填充 L1。L2 TTL、权威 sequence 操作保持原契约。此前依赖无限/负 L1 上限的消费者需要改用有效配置。
- 无 schema/data 迁移。回滚需要按修复文件的局部差异操作，避免覆盖工作区原有修改；若回滚 HTTP 新选项，同时撤回两个消费者的接线。回滚会重新引入相应旧风险。
- 当前仅为源码联调结果。新选项和修复需要后续不可变版本发布，独立消费者需升级对应制品；本轮未修改包版本，也未将源码 alias 当作发布依赖。


## 后续：3 包旧测试类型错误修复

用户追加授权后完成以下局部修复，运行时实现与公开 API 未变：

- fe-auth：[store.spec.ts](../../../packages/fe-auth/src/store.spec.ts) 显式导入 Vitest API；[package.json](../../../packages/fe-auth/package.json) 增加已有工作区版本的 `@types/node` 开发依赖，[tsconfig.json](../../../packages/fe-auth/tsconfig.json) 显式载入 Node 类型，使浏览器测试的 Node HTTP 服务端夹具参与完整类型检查。
- network：[nest-common-shim.d.ts](../../../packages/network/src/nest-common-shim.d.ts) 移除遮蔽 Node 标准类型的旧全局 Buffer 声明，原 `Buffer.isBuffer` 断言继续保留。
- tracing：[tracer.spec.ts](../../../packages/tracing/src/tracer.spec.ts) 使用现有 `Sampler` 接口声明测试实例，按真实调用端的接口契约传参，无需改动采样器实现或放宽类型检查。

验证：三个包完整 `tsc --noEmit` 均退出 0，无排除旧测试、类型断言绕过或新增 suppress。先运行最小相关测试，34 项通过；再运行三个包全部默认测试，21 个文件中 **180 项通过、0 失败、5 项跳过**。5 项均为 `oauth-popup.browser.spec.ts` 的显式 opt-in 真实 Chromium 测试，本次未启用；其测试代码已通过 TypeScript 检查。ESLint 0 error（tracer.spec.ts 有 3 个原有未使用变量 warning），定向 diff 空白检查通过。

```sh
pnpm exec tsc --noEmit -p packages/fe-auth/tsconfig.json
pnpm exec tsc --noEmit -p packages/network/tsconfig.json
pnpm exec tsc --noEmit -p packages/tracing/tsconfig.json
env -u TEST_DATABASE_URL -u TEST_REDIS_URL -u AI_ACCESS_POSTGRES_TEST_URL -u S3_MINIO_ENDPOINT -u RUN_BROWSER_TESTS pnpm exec vitest run packages/fe-auth packages/network packages/tracing --maxWorkers=3
```

依赖处理：普通离线 add 尝试触发工作区其他模板依赖解析，因本地元数据没有所需可选版本而失败，未改动原 manifest/lock。随后仅补齐 fe-auth importer 与开发依赖声明，按工作区 override 使用 `20.19.43`，通过定向 `--offline --ignore-scripts --frozen-lockfile` 安装验证。与本轮开始时的锁文件比较，仅增加该 importer 的 3 行，没有升级其他依赖。无数据库迁移或运行时回滚要求；未构建、提交、发布或部署。


## 提交前验证与已知限制

用户授权提交并推送当前全部源码改动（排除本地缓存），本轮使用 `codex/package-review-fixes` 审阅分支。
前述“未提交/未推送”为各修复阶段当时的状态。main 推送会进入自动发布流水线，因此本轮没有推送 main、
构建生产制品或发布包；新增 Changeset 记录后续 patch 发布范围，没有修改已发布版本。

- 根 Vitest 套件：582 个文件，**6,621 通过、125 跳过、1 失败**。完整复跑（并发从 4 降到 2）仍为相同结果。
- 唯一失败是 `packages/ai/src/langchain-openai-compatibility.spec.ts` 中 jsonMode 结构化输出的默认 5 秒超时。
  单独运行该文件 **13 项通过**，该项耗时约 4.72 秒；临时分段测量使用 15 秒上限时调用阶段耗时 5.776 秒，
  所有请求/输出断言通过。尚未确定耗时原因，未改动原测试、断言或超时配置；临时测量文件已移除。
  这项完整套件失败作为已知限制保留，不将单项通过描述为完整套件通过。
- Web Vitest 套件：14 通过、0 失败。
- 指令、CLI 入口、catalogue、launch-ready 和 ext-kit 的 Node 测试：65 通过。
- 131 个改动代码文件按各工作区的 ESLint 版本检查：0 error；root/server 保留 90/2 个 warning。
  首次根 ESLint 10 跨工作区调用碰到 Web ESLint 9 插件 API 不兼容，改用模板已声明的本地版本后通过。
- 代码 diff 空白检查通过；原始历史日志、可应用 patch 的上下文空行与 Markdown 换行标记保持原样，
  未为消除归档文本的空白提示而改写已有证据。
- PostgreSQL/Redis/MinIO 环境变量与 opt-in 浏览器测试开关已移除；跳过项不作为外部服务验证通过。

## 后续：AI SDK 结构化输出测试超时

上节记录的 jsonMode 超时已定位：安装的 LangChain SDK 在流式 `invoke` 收集结果后，仍调用
`BaseLanguageModel.getNumTokens` 估算 token 数。首次使用会通过全局 fetch 下载
`https://tiktoken.pages.dev/js/gpt2.json`，绕过测试注入的 OpenAI transport。
临时 CPU 采样中调用耗时约 4.287 秒，其中约 4.118 秒为空闲等待；仅加入禁止额外请求的检查，
原用例在约 249 毫秒内失败，并明确记录两次词表下载请求，确认了隐藏的外网依赖。

[兼容测试](../../../packages/ai/src/langchain-openai-compatibility.spec.ts) 现在在每个用例中替换公共
`getNumTokens` 方法为固定的合成计数，覆盖结构化输出内部创建的 SDK 实例；请求构造、流解析、
结构化输出和 provider usage 断言继续使用真实 SDK。全局 fetch 拦截器禁止额外网络访问，
即使 SDK 捕获网络错误后降级，测试结束时仍检查并拒绝这种访问。拦截器使用 AbortError
避免 SDK 重试退避延续到测试清理之后，每个用例结束时恢复 mock 与全局变量。
默认 5 秒上限、原有断言、依赖版本和运行时代码均未修改。

验证详情见 fix-evidence.json 的 `aiSdkTimeoutFollowup`：

- 兼容文件 13 项全部通过；jsonMode 约 3.6 毫秒，jsonSchema 约 4.5 毫秒。
- `vitest run packages/ai --maxWorkers=4` 匹配 ai、ai-access 和 ai-tasks：53 文件，432 通过、22 跳过。
- 根套件按默认超时、4 workers 复跑：582 文件，6,622 通过、0 失败、125 跳过；jsonMode 约 8.6 毫秒。
  使用与提交前相同的环境变量移除命令，未访问真实付费 provider，也未启用外部服务或浏览器 opt-in 测试。
- 本次兼容文件及其导入闭包通过定向 TypeScript 检查，ESLint 0 error / 0 warning。
- 额外执行 AI 包完整 TypeScript 检查，6 个未改动的旧测试文件仍有 49 个错误：缺少 Vitest 全局声明、
  缺少 MediaGenerationConfig.apiKey，以及旧 NativeStreamOptions.maxAttempts。该完整类型检查未通过；
  本次没有扩大范围修改这些测试，也没有将定向类型检查描述为全包类型检查通过。

本次仅调整测试及审阅证据，无公开导出、消费者接线、数据库迁移或发布制品变化；回滚只会恢复测试的外网依赖。
