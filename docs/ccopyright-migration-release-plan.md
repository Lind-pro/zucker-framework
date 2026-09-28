# CCopyright 全量接入所需 Framework 发布批次

日期：2026-09-28。状态：本地源码修复与定向验证已完成，51 个公开包已统一版本化为 **1.0.5**，registry 已逐包检查未占用；正在进入构建/提交/推送/发布门禁。实际制品、完整门禁和消费者正式接入尚未完成。

## 发布范围与版本建议

维护者已明确要求：**Framework 只增加补丁位；不保留被替代的旧公开 API，不实现兼容层，彻底修复并同步迁移调用方。** 这是本批版本策略的明确例外：补丁号不表示接口兼容，不能以兼容性为理由保留重复实现。

现有 `.changeset/config.json` 配置 51 个公开包为一个 fixed group，保留该发布范围；本批 changeset 已按用户指令以 patch 应用。Changesets 实际生成的51包版本均为 **1.0.5**，registry 逐包查询无冲突。私有模板不参与版本递增和发布。发布前仍须由现有门禁复核不可变版本，不能覆盖。

本批不是只发布 auth/credit；未改变 fixed-group 范围。废弃接口与本地重复实现随消费者替换清除，明确记录流类型、扩展授权配置等接口变化，不提供旧API转发壳或双轨运行。

| 主要包 | 本批变化及消费原因 |
| --- | --- |
| auth | 同密码更新安全、部分更新、用户角色绑定；refresh/CAS/revocation、严格 bearer/optional/local guard |
| credit | 持久额度预留状态机及事务端口；产品保留套餐、原表与期间政策 |
| ai | strict 场景、记录身份、native ports/usage、费用 flush、模型构造 transport |
| core/common | 请求取消、lease、并发 drain、shuffle、有界上传 |
| storage | WebDAV 流式传输/取消/目录语义，公开类型直接修正为 Readable，不保留错误的旧类型声明 |
| media | 浏览器池及文档抽取/命令/ZIP/OCR ports；声明检查明确使用 Node20 类型 |
| queue/logging | producer/worker 生命周期、任务预算/统计、drain；查询参数防御 |
| fe-http-client/fe-storage | 二进制错误、取消、refresh、raw response、登录页401、SSR cookie |
| ext-kit | engine/popup/scroll/offscreen 一致交付；恢复检查点/资源lease/授权策略接口直接替换旧契约 |

## 本地证据与限制

- 待发布变更的 29 个 spec 文件：233 项通过；涵盖上述认证、AI、IO、队列、存储、前端等契约的定向回归。
- 公共契约测试类型修正后，core/common 相关 5 个文件 47 项通过；没有删除断言或跳过用例。media 新增直接开发依赖 `@types/node@20.19.43`，没有运行时依赖升级。
- auth、credit、ai、core、common、fe-http-client、fe-storage、logging、media、queue、storage、ext-kit 包级 noEmit 通过。测试全局类型显式包含 vitest/globals；core/media 保留 node 类型。编译没有生成发布制品。
- CCopyright 重组后的真实组件浏览器：正式旧包16/20、显式 test-only HTTP 源码联调20/20。该结果证明接入方向，不证明新发布包内容或完整生产站点。
- 新增用户/预留及有关源码 lint、双仓 whitespace 检查已通过。完整 release hook/CI、干净 Linux 构建、实际 tarball ESM/CJS 与 peers、真实 PostgreSQL/Redis 合约尚未验收。
- 合成端口不证明跨进程锁、持久恢复或真实外部投递；不把上述数量相加成全仓测试数。

## 获准后的执行顺序

1. 检查工作区范围，保留非本批工作；核对 51 包 fixed group 的版本变化和全部 breaking migration notes，生成一致 manifest/lock。
2. 执行本仓 [package release](package-release.md) 规定的本地门禁和制品检查；真实基础设施仅使用已明确授权的隔离测试目标，不接生产。失败即修复，不跳过 hook。
3. 按授权提交、推送本批源码，由精确 commit 的 CI 生成和验证不可变制品。
4. 审核制品清单/校验值后按既有流程公开发布，不能复用旧版本或用本地脏 tarball 替代 CI 制品。
5. CCopyright 固定正式版本接入，验证每项消费者并删除旧实现；更新锁文件、公开出口和必要扩展资产。不自动发布其他产品或部署 CCopyright。

用户对本批交付请求的回复限定“只增加补丁位”，随后明确禁止保留旧API/兼容层。本批依该限定继续准备和验证，任何交付不得超出该限定，不包含 ccopyright 部署，不覆盖已发布版本或绕过门禁。
