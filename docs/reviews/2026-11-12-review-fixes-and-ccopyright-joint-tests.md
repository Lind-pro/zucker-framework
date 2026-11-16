# 1.0.18 后问题修复与 ccopyright 联合验证

修复基线：Framework `main` / `aee88b9bcd0b4f4bd181ac3b7116897f70af63d2`。对应原报告：`2026-11-12-1.0.18-to-aee88b9.md`。

消费者基线：`Lind-pro/zucker-ccopyright` 的 `migrate/framework` / `dac278e10e9896d89e5607cf6326d13d3cb3318a`；该提交的 Framework 依赖固定为 **1.0.21**。本轮通过只读 `git archive` 创建隔离副本，并用测试专用 source aliases 接入 Framework 修复。没有改消费者正式依赖为源码路径，没有发布新包。

## 后续证据同步（2026-11-12，当前状态）

“升级落地页并接入 Google 与 Stripe”会话已接续联合验收及剩余修复。本节根据用户同步及已读取的 [真实持久化后续报告](2026-11-12-real-persistence-followup.md) 更新状态；本次同步不重新执行测试，不并行修改该会话正在处理的源码。下文首轮数据、限制和原证据 ZIP 保留为历史快照，不能继续把当时的环境阻塞或补丁未写回状态当作当前结论。

| 范围 | 接续验收结果 | 证据来源与状态 |
| --- | --- | --- |
| CCopyright 数据库相关测试 | 235 项已执行，230 通过、5 个业务失败 | 用户同步；5 项仍在接续会话处理，不能视为整体通过 |
| CCopyright 浏览器 | 106/106 通过 | 用户同步；此前本地监听/Chromium 环境限制已解除 |
| CCopyright 真实 AppModule | 8/8 通过 | 用户同步；补充了首轮未执行的真实应用装配验证 |
| migration-lab | 12 个控制通过 | 用户同步；不代表执行了生产迁移 |
| Framework 真实 PostgreSQL/Redis | 83 个唯一用例最终通过，0 失败/跳过 | 后续报告及其原始证据；只覆盖列明的 suite，不据此宣布全部 23 项或发布门通过 |
| 消费者共享 CRUD adapter | 补丁已写回，真实 PG/source 联合验证通过 | 用户同步；无需重复应用原补丁 |
| 消费者正式 Framework 依赖 | 仍为 1.0.21，动态事务读取回归仍失败 | 用户同步；源码修复通过不等于正式发布包已修复 |

本次只读核对了后续报告引用的原始 JSON/log：83 = 首轮 PostgreSQL 67 + 最终 PostgreSQL 15 + 修复后 Redis 1；`real-contracts` 保留 67 通过、Redis 1 失败，`sequence-fixed` 为 20/20（其中 Redis 1 项，其他关联单测不重复计数），`cleanup-check.json` 的残留测试 schema 为 `[]`。RESP 数字/字符串诊断原文未保留在这些日志中，其细节依据后续报告记录；失败与修复后通过的对照文件均存在。

**新增 Redis 边界缺陷已修复于本地候选代码**：Lua 以 RESP integer 返回接近 `Number.MAX_SAFE_INTEGER` 的 sequence 时，ioredis 解码丢精度。现改为十进制 bulk string 返回并严格校验；原失败、修复后的成功及接近安全整数上限的并发回归均保留。公开 API 签名、数据库 schema 和消费者配置不变。该修复属于 R01 新增实现的边界补充，不能描述为已发布 1.0.21 的新增回归。

接续归属：**Framework admin 事务内策略 hook、CC 管理员保护、订阅通知及上述剩余业务失败，由接续会话继续处理**。本会话只同步证据，避免同文件并行修改。新证据只覆盖其 `source-hashes.json` 记录的版本，后续源码变动需对应复验。

发布/生产状态保持：未提交、未发布、未改生产，消费者正式依赖尚未替换。完整依赖安装、发布制品及尚未完成场景的验收仍分别记录，不能由本节的局部通过结果推定。

## 首轮结论与范围（历史快照）

原报告 23 项均已实现本地修复并补回归。以下“已修复”表示源码和对应本地验证完成，**不代表已部署或已完成发布制品、真实数据库和完整浏览器验收**。

ccopyright 实际源码的联合验证另外确认并修复了一处消费者接线问题：`PrismaCrudService` 重建 adapter，导致它与全局 `DynamicQueryService` 的事务身份不一致。隔离副本修复后验证通过，补丁在 `2026-11-12-ccopyright-shared-crud-adapter.patch`。该补丁已对原消费者工作区执行 `git apply --check`，但受本会话可写范围限制，**未写回 ccopyright 原工作区**。检查时该工作区还存在其他任务的新测试改动，均未触碰；本轮联合结果只针对上述固定提交和本补丁。

没有提交、推送、创建 PR、生产构建、发布或部署；没有执行真实数据库迁移，也没有调用收费 AI、真实支付或邮件服务。

## 23 项处理结果

| ID | 修复及回归要点 | 主要位置 |
| --- | --- | --- |
| R01 | 撤销水位改为原子推进；读取绕过 Hybrid L1。覆盖乱序/并发、TTL、损坏状态；不支持新契约的自定义缓存明确失败 | `packages/cache/src/*cache*`；`packages/auth/src/services/token.service.ts` |
| R02 | 凭据修改、credentialVersion 与 refresh session 撤销同事务；失败后相同请求可重试；事件在提交后发布 | `packages/admin/src/users/`；`packages/auth/src/services/user.service.ts`；`packages/back-office/src/accounts/admin-user-hooks.ts` |
| R03 | 持久保存支付应用快照和退款标记，排除已退款付款后重放权益；验证两种退款顺序、重放、管理员基线、回滚 | `packages/payment/src/plans/subscription-assignment.ts`；`packages/back-office/src/subscriptions/payment-history.ts` |
| R04 | billing link 显式优先返回有效 provider subscription，防止 pending checkout 掩盖它 | `packages/back-office/src/subscriptions/billing-link.ts` |
| R05 | 提交前、已接收、已生成、已存储分别持久化；结算失败恢复检查点；未知提交结果不自动再次生成 | `packages/ai-tasks/src/ai-task.service.ts`、`store.ts`、schema 与新迁移 |
| R06 | 能力校验在扣费前执行；DALL-E 3 拒绝多图，DALL-E 2 返回完整批次；少交付不确认整笔积分 | `packages/ai/src/providers/dalle.provider.ts`；模板 AI host |
| R07 | 下载/存储阶段有独立超时，覆盖等响应头、正文停滞、续租期间超时；失败释放冻结额度 | `packages/ai-tasks/src/ai-task.service.ts`、`rehost.ts` |
| R08 | 过期 pending SET 回放后正确删除旧操作；按操作身份保留新的写入，合并并发回放 | `packages/cache/src/redis-cache.service.ts` |
| R09 | 页头与主客户端共用身份保护；阻止跨账号 cookie 刷新接管，切换账号取消旧请求 | `templates/web/src/lib/account-session.ts` 及登录/OAuth 接线 |
| R10 | 按流累计实际字节，超过 16 KiB 立即取消并返回 413，不依赖 Content-Length | `templates/web/src/app/api/revalidate/route.ts` |
| R11 | 动态列表、计数和 exists 使用事务 adapter；另补消费者共享 adapter 接线 | `packages/crud/src/dynamic-query.service.ts`；消费者补丁 |
| R12 | 每次 flush 回收已失效的同伴认领，覆盖首次 flush 后同伴崩溃 | `packages/buffer/src/persistence-buffer.ts` |
| R13 | revision 0 也约束 test/live mode；bootstrap 不可用时拒绝猜测；保留同模式密钥轮换 | `packages/back-office/src/billing/payment-credentials.ts` |
| R14 | 异步获取 provider 前监听连接关闭，释放提前断开的租约 | `packages/back-office/src/settings/hot-apply.ts` |
| R15 | 后台邮箱规范化；登录精确、大小写不敏感查询历史邮箱，冲突身份拒绝登录 | `packages/admin/src/users/`；`packages/back-office/src/accounts/account.service.ts` |
| R16 | 数据库 CAS 决定 TOTP 是否已使用；数据库失败/回滚不消耗本地有效验证码 | `packages/auth/src/two-factor/`；back-office two-factor service |
| R17 | 用 stream pipeline 绑定校验流和存储读取生命周期，中断/校验失败关闭上游 | `templates/server/src/files/files.service.ts` |
| R18 | 声明并校验参考图数量能力；传递全部允许的参考图，禁止静默丢弃 | `packages/ai/src/media.interface.ts`、HTTP provider；模板 AI host |
| R19 | 末页唯一未读项标记后修正页码，实际组件重新加载上一页 | `templates/web/src/features/inbox/inbox-state.ts` |
| R20 | 路径/权限配置保留合法键、值接受 string；加入类型消费用例 | `packages/back-office/src/billing/billing.options.ts` |
| R21 | 从本次制品 registry 预热 Framework metadata/tarball，再离线 dlx；预热失败不继续 | `scripts/acceptance/launch-ready.mjs` |
| R22 | 统一 canonical realpath 入口识别，符号链接调用真实执行；导入仍不执行 | `scripts/cli-entry.mjs` 及 8 个调用脚本 |
| R23 | `--no-web` 省略 WEB_URL/SITE_URL 赋值并提示自行配置；不使用会使服务启动失败的空串 | `packages/cli/src/commands/create.ts`、`doctor.ts` |

独立二次复审还修正了新恢复逻辑的两处边界：`recoverSubmission` 保留 resolver 的 `this`；超时发生在续租等待期间时，不再在续租返回后启动上传。对应失败复现已转为通过。

## 首轮验证结果（历史快照）

以下按验证范围列出，重跑不重复累计；各组不是发布门。

| 范围 | 结果与边界 |
| --- | --- |
| cache / crud / buffer | 32 文件，598 通过；3 个包 noEmit 通过；真实 Redis 合约 1 项跳过 |
| auth / admin users / accounts | 原扩展 506 通过，后补 1 条事务/encoder/事件回归通过，共覆盖 507 项；其中持久事务专项最终 5/5。真实 PostgreSQL 合约 13 项跳过 |
| payment / back-office billing、settings | 9 文件，183/183 通过，包含 PGlite 支付历史、回滚、完整退款 hooks 和 no-outbox 兼容路径 |
| AI tasks / providers / 模板 AI host | 最终 9 文件，116/116 通过，包含检查点恢复、迁移映射、未知提交、数量/参考图能力与超时取消；独立复审的续租超时复现另 1/1 通过 |
| Web / fe-auth / fe-admin | 66 项不重复通过：真实模块/组件 14、session/admin 39、原 Node 流程 13 |
| CLI / 验收脚本 | 新回归 9、相邻脚本 27、CLI 模板矩阵及 doctor 35，均通过 |
| 大文件流 | 5/5：取消、超长、存储错误、正常字节、摘要不匹配 |
| 修改范围的静态检查 | 定向 ESLint 无错误；各组新源码/公开接口定向 noEmit 已检查；不等同于完整模板或发布声明构建 |
| 新回归发现路径 | Web 新增 `pnpm test:web`，接入 PR checks 和 pre-push；Node 新回归接入既有 CI 列表；Redis sequence 纳入 durable-runtime 列表。均未执行远程任务 |

PGlite 用来验证实际 SQL、约束和事务回滚；生成的 Prisma client 使用测试 delegate facade，**不证明真实 PostgreSQL 多连接竞争、Prisma 驱动或生产 schema 迁移**。没有把环境跳过项算作通过。

### ccopyright `migrate/framework` 实际源码联合验证

| 场景 | 结果 |
| --- | --- |
| 实际 `CopyrightUsersController`、`copyrightAccountOptions`、`CopyrightDatabase` | 2/2 通过：邮箱/验证状态/version/session 整体回滚，重复请求成功；实际默认 username 保留，显式 email opt-in 下旧大小写数据可登录、冲突拒绝 |
| 实际 `PrismaCrudService` 与 `CopyrightDatabase` | 原代码复现事务内列表遗漏及 transaction limits 未使用；消费者补丁后 1/1 通过，覆盖 findAll/count/exists、回滚退出、事务参数 |
| 实际 `COPYRIGHT_SUBSCRIPTIONS_STORAGE`、host options、model aliases 与 database | 3/3 通过：Phase 2 direct recordPayment/replay 不需要 outbox，产品事务失败回滚证据，未绑定 history 的新自动退款接口明确拒绝 |
| Landing/Admin 接线核对 | Landing 已使用 guardedRefresh、token 身份校验和请求取消；Admin 使用公共 session 工厂。无需复制模板的 R09 接线 |
| Landing 浏览器回归 | 保留该分支原 12 例，新增跨账户 2 例；source alias 内存编译成功。浏览器未启动，**0 条页面断言执行** |

联合用例使用当前修复源码和固定消费者提交。消费者仍声明 1.0.21，因此这些结果不能替代新版本发布后按真实锁文件安装的兼容性验收。

## 首轮未完成验证与限制（当前变化见顶部同步）

1. 消费者本地依赖不完整。浏览器 harness 临时使用已有 Framework 的 React 19.2.8 及 4 个 UI 依赖，版本与路径保存在 evidence 的 provenance 中；不是精确消费锁文件验收。
2. Playwright 默认 `headless_shell-1234` 缺失；指定已安装 Google Chrome 后启动 SIGABRT，清理日志有 EPERM。14 个浏览器用例均在 before hook 阻塞，不能报作产品用例失败或通过。
3. 未启动 ccopyright 完整 AppModule、HTTP 服务，未跑真实 PostgreSQL/Redis 多连接合约、完整迁移实验或付费提供商。未提供本轮明确的临时数据库/Redis 端点。
4. 普通 Web 模板 tsc 仍受旧 `.next` route types、旧 dist 与缺失 qrcode-generator/fe-blocks 影响。定向源码 noEmit 不能冒充该命令通过。
5. 新测试复用仓库已锁定 PGlite 0.5.8，两个 package manifest/importer 已更新。根目录执行 `pnpm install --lockfile-only --offline --ignore-scripts --frozen-lockfile` 在 supply-chain 检查阶段因缺少 `@inquirer/checkbox` 离线 metadata 失败；未重装依赖，不能声称完整锁文件安装校验通过。
6. R21 验证了冷缓存情况下的命令次序、失败停止和真实脚本入口；没有执行真实制品下载/安装、Docker 或完整 release gate。

## 接入、迁移和回滚

- **auth/cache**：配套升级；自定义认证缓存实现 `advanceSequence` 与 `readSequence`。新旧非原子撤销 writer 不可混跑。回退旧 writer 会重新引入 R01。
- **管理员 hook**：旧 `sensitiveFieldsChanged`-only 实现启动时明确拒绝，迁为 `sensitiveFieldsChanging(change, tx)`；所有必需撤销写入加入同一事务。ccopyright 使用 canonical hook，已联合验证。
- **退款历史**：默认 BackOffice fulfillment/refund hooks 使用现有 JSON outbox 保存永久账本记录，无额外 schema 字段。history kinds 必须排除 outbox 投递清理，并随付款账本长期保留。旧付款无应用快照时自动退款 fail closed，需基于审计证据补齐后重试，不能推测管理员权益。ccopyright Phase 2 付款 writer 默认不绑定此历史，现有付款不受影响；Phase 3 显式接入。
- **支付 revision 0**：运行时可保留原 bootstrap mode，但它不是跨进程不可变历史。跨重启变更环境 mode/account 要换 accountScope 或使用持久化 revision，不能复用 scope 猜测旧订单环境。
- **AI tasks**：新增 expand-only 迁移 `templates/server/prisma/migrations/20261112150000_ai_execution_checkpoints/migration.sql`，增加 `executionState`/`generatedOutputs`。旧已尝试但无 provider id 的任务转为 SUBMITTING，避免重新付费提交。迁移未执行；升级前停/排空旧 worker，新旧 worker 不混跑。回滚也需先处理活跃任务，保留新增字段，不能让旧代码重新消费未知提交任务。
- **AI 外部副作用**：无提供商幂等/查询能力时不能保证外部 exactly-once。未知提交不重发，有恢复端口时查询；生成响应、输出和结算分阶段恢复。已启动且不支持取消的 buffered storage I/O 无法被强制撤销，可能留下未挂接对象；有取消能力的 putStream 更适合大文件，保留对象清理机制。
- **模板/UI/CLI**：没有数据库迁移。模板修改不会自动升级已有消费者；本轮已核对 ccopyright 的实际接线。`--no-web` 用户需要自行提供邮件/站点所需前端 URL。

当前后续工作由顶部列明的接续会话负责：完成剩余业务修复及对应回归，之后对包含修复的新不可变 Framework 制品进行消费者安装与验收。消费者共享 adapter 补丁已由接续会话写回，不再列为待应用项；正式 1.0.21 的事务读取失败仍待新制品替换后复验。发布、部署或生产数据库迁移没有因证据同步而获得授权。

## 证据文件

`2026-11-12-review-fixes-evidence.zip` 保存本轮可用原始日志、联合测试源码/配置、浏览器 harness/provenance、消费者补丁与路径清单。临时配置包含本机绝对路径；复现时需要对应提交的消费者隔离副本及已有依赖，不能把缺失依赖或未运行的浏览器场景算作通过。正式回归测试也保留在各 package/template 的测试目录中。
