# 通用 Admin 模板接入核对（I4）

核对日期：2026-10-24。本文保留接入核对依据，并记录本轮已经落地的切片；源码和本地验收不代表生产部署。范围是通用管理基础设施；不引入 CNIPA 专利业务页面，也不包含 AI 图片、视频、聊天产品。

## 复用边界

当前仓库没有 `fe-table` 或 `fe-layout` 包。模板已经使用公开的 `@ant-design/pro-components`：`ProLayout` 负责布局，`PageContainer` 负责页面，`ProTable` 负责查询列表，`ModalForm`/`ProForm` 负责表单。继续复用这些组件，不另建同功能包。

Framework 公开入口可直接复用：

| 公开能力 | 当前入口 | 消费者保留的内容 |
| --- | --- | --- |
| 登录状态、权限匹配、刷新 | `fe-auth`、`fe-http-client`、`fe-permission` | 路由、权限编码、账户操作政策、错误文案 |
| 动态表单 | `fe-form` 的 `DynamicForm`、字段和校验类型 | 表单定义与业务字段 |
| 持久配置、通用管理接口 | `config`、`admin`、`auth` | 配置白名单、已启用能力、菜单树、API 返回字段 |
| 内容结构与主题解析 | `fe-site/content` | CMS schema、发布策略、编辑界面和命名主题注册表 |
| 文件/任务/通知/支付机制 | 各对应公开包 | 当前用户与管理范围的边界、敏感字段投影、操作授权 |

`createReadOnlyAdminController` 能复用分页和有限过滤，但目前直接返回模型记录，没有返回字段投影选项。它不能不加审查地套在订单、任务、用户或私有文件模型上，否则可能公开私有 fulfillmentData、执行参数、存储键等。先在消费者提供明确 DTO/查询，再决定是否值得提取确有第二个使用者的公共投影选项。

ShipAny 本地参考的可观察行为包括：按用户权限进入管理端、按页面权限读取资源、内容/身份/交易分组、订单/订阅列表过滤与分页。这里借鉴行为，不复制其商用页面、表格实现或产品模块。

## 建议菜单

| 一级入口 | 二级功能 | 边界 |
| --- | --- | --- |
| 概览 | 一个管理首页 | 已授权资源摘要、待处理事项、常用入口；未知/无权限/读取失败不能显示成 0 |
| 用户与权限 | 用户、角色、权限 | 复用已有管理 API；角色授权和账号状态变化走原服务契约 |
| 内容与站点 | 页面/博客/文档、博客分类、品牌/导航/主题/SEO | 复用已验证的 `/content/manage` API；不用 iframe，也不直接搬 Next 页面到 Vite |
| 交易与额度 | 订单、订阅、退款、积分流水 | 管理范围接口与个人账单接口分开；供应商未确认的状态保持待核对 |
| 运行与审计 | 任务、通知投递、文件资产、访问/操作日志、健康检查 | 先提供真实持久查询；下载、恢复、取消、重发等动作单独授权 |
| 系统设置 | 菜单、字典、已接通的连接配置；可选高级功能 | 租户、翻译、动态表单按实际持久化与启用情况显示 |

不再增加与概览/监控重复的“数据分析”入口。经营分析需要明确的数据口径和真实持久聚合，才能成为可用页面。通用任务页面展示任务生命周期与失败信息，不包装成图片/视频/聊天产品。

## 核对起点（修复前事实）

| 位置 | 当前事实 | 最小处理 |
| --- | --- | --- |
| `templates/server/src/accounts/create-administrator.ts` | 显式管理员初始化已经创建 11 个平铺 starter 菜单，不是完全缺少初始化 | 维护消费者菜单目录；按分组补已接通页面。新装初始化与已有实例的显式同步分开；不在服务启动时改权限或覆盖用户自定义菜单 |
| `templates/admin/src/pages/Menu` | 提交 `sortIndex` 和 `type`，真实 `MenuNode`/Prisma 字段是 `sortOrder`、`status`、`permissions`、`properties` | 对齐真实字段；管理列表用 `/menu/all`，不要用当前用户可见树代替完整管理列表 |
| `templates/admin/src/layouts/BasicLayout.tsx` | 菜单加载失败被吞掉；当前路由全静态注册，隐藏菜单不等于路由/API授权 | 显式加载/失败/重试/真实空状态；过滤未安装路由。路由权限用于UX，API权限仍是权威 |
| `templates/server/src/app.module.ts` | `ZuckerMonitoringModule` 和默认 `ZuckerAdminModule.forRoot()` 都注册 `GET /health` | 组合根只选一个健康入口；不改消费者之外的全局模块职责 |
| `templates/admin/src/pages/SystemMonitor` | 读取 `details`，monitoring 实际返回 `checks`；另一 health 入口返回 `status: ok`；请求失败直接显示 DOWN | 使用真实健康 DTO，区分进程存活、已注册依赖检查、查询失败。无注册检查不宣称数据库/Redis正常 |
| `templates/admin/src/pages/Dashboard` | 多个请求失败后保留初始 0；近期日志失败显示空记录；全部快捷入口固定展示 | 复用统一摘要 DTO 或按权限加载各项，并明确失败。不得把权限不足或存储不可用伪装成无数据 |
| `packages/admin/src/logging/logging.controller.ts` | 默认管理路由仍读取内存 ring buffer，只支持 userId/method/module；SystemMonitor 传入的 `statusCode$gte` 不会筛出错误 | 接入已有持久日志服务/公开管理工厂，明确白名单过滤；不能把当前页面当作持久审计验收 |
| `packages/admin/src/notification/notification.controller.ts` | 默认模板/历史管理仍走内存服务 | 用本轮持久 delivery/template 查询契约接管理页；保持提供者已接收、已送达、失败和未知的区别 |
| `templates/admin/src/pages/Config` | 页面写 `system` scope 的站点/SMTP/注册/验证码字段；当前账户/邮件实际从环境和各自配置读取 | 只显示已连接到消费者服务的设置。站点品牌使用 `site.publicSettings`；秘密采用明确写入/已配置状态，不从任意配置对象回显 |
| `templates/admin/src/pages/Tenant`、`I18n` | 默认 store 为内存；Tenant UI 用 status，服务用 enabled；I18n UI 用 lang/key/value，服务用 code/translations | 尚未接持久 store 时不列为已完成管理功能；启用时同时对齐 DTO 与重启持久性 |
| `templates/server/src/billing`、`jobs`、`files`、`delivery` | 当前个人接口以 req.user.id 限定归属；存在这些接口不等于全局管理查询已完成 | 单独定义有限管理范围与权限的 DTO/查询。不得借用“我的订单/任务/文件”伪装管理全局列表 |
| `templates/web/src/features/content` | Web 工作台与真实 CMS API 已验证，但导入 Next 路由/i18n 组件 | Admin 做薄的 ProTable/ProForm 消费者；共享文档数据契约和服务端发布操作，避免复制持久逻辑或造第二套CMS |

## 落地顺序与完成证据

1. **先使现有骨架可信**：对齐菜单 DTO、显式菜单加载错误、路由可用能力和权限；解决重复健康入口及检查 DTO。复用现有登录/刷新/权限机制，避免顺带重写身份模块。
2. **完成内容管理接入**：Admin 列表/编辑/分类/站点配置直接调用现有 CMS；保留预期版本、草稿与发布快照、禁用块过滤、来源检查。通过真实 Admin 入口创建、保存、发布、冲突、下线，再由公开 Web 验证结果。
3. **接交易与运行记录**：与正在完善的退款、积分、任务/投递模块共同确定管理读接口和字段投影。先只读列表/详情，再对已经有可靠命令契约的动作加按钮；绝不在 UI 自行改数据库状态。
4. **收敛可选系统页**：只有真实持久化、实际读取配置和权限均已接通的模块才进入默认菜单；其余明确标为未启用，不能以示例数据填充。

每个切片的验收覆盖：真实登录和权限、未授权直达路由/API、实际分页/过滤、空与错误状态、写操作失败/冲突、持久化重启、相应下游公开结果。布局只做受影响桌面/窄屏验收；支付/邮件/AI均用测试提供者或合成适配器，不调用真实收费服务。已有未改输入的证据继续复用，不为整理菜单重跑全部业务流程。


## 当前切片结果

已实现六组默认菜单与真实 `sortOrder/status/permissions/parentId` 管理字段，初始化仅新增缺少的 starter 记录，不覆盖既有自定义。菜单失败可重试，直达路由按功能权限处理；tenant/i18n/旧内存通知模板直达页明确未启用且不调用业务接口。

Admin 已接通 CMS 草稿/发布/分类及真实 `site.publicSettings` 编辑；订单、订阅、任务、投递、文件、访问/操作日志使用消费者 `ManagementModule` 的显式分页字段投影。订单/订阅的名称来自真实冻结 `offer.description`，金额保持十进制字符串，不向浏览器发送私有 offer、渠道 metadata、租约、任务 payload 或存储键。

`/management/api-keys` 使用独立 `api-keys:query` 权限，只有列表/详情展示；返回用户、名称、可识别前缀、有效/撤销/过期状态与时间，不选取 hash/完整 secret。个人 API Key 管理保持原归属接口。

积分管理只允许 `credit:grant` 正向发放，沿 canonical batch ledger 和 PostgreSQL operation coordinator，在同一事务中写批次、余额、流水和操作者审计。请求键绑定操作者与完整申请摘要；并发、重启和丢响应后刷新重试保持一次发放。浏览器只保存摘要和随机重试键，提交前重新向服务端确认账户身份。`credit:query` 使用 `CreditsService` 的批次可用额度投影，负调整/新增冻结尚未实现，不提供按钮。

连接配置通过独立 `CONFIG_ENCRYPTION_KEY` 加密保存支付、登录、账户/任务邮件、私有存储、公开站点和可选原生 AI 连接，共 16 个 profile。只读状态与实际 SDK 工厂共用不可变 `RUNTIME_ENVIRONMENT`；保存显示新的 storedRevision，运行 appliedRevision 在 Server 重启前保持不变。前端按 descriptor 渲染，字段默认保持原值与来源；密钥仅允许保持/替换/清除且从不回显，清除屏蔽环境回退。写权限、可信 Origin、CAS 版本和事务审计由 API 强制，冲突不覆盖其他人的修改。六个 AI 连接默认关闭，启用时仅构造现有 native SDK，未验证远端凭据或模型能力；旧 ProviderManager 注册表单列展示。消费方声明业务场景到固定连接的映射，未知或关闭的连接在旧数据库默认模型回退前失败；不包含图片、视频或聊天产品页。公开网站设置由 Server 已应用快照的公开接口提供给 Web，不依赖构建时内嵌密钥。

本轮核对 ShipAny 1.8.3 后确认：其邮件设置只有 Resend 凭据/发件人配置，验证邮件为源码固定 React 组件，没有后台可编辑邮件模板。因此可编辑 durable 邮件模板不是现有 ShipAny 对齐缺口；旧内存模板页保持未启用。退款管理已接入真实退款宿主：订单/本地周期选取、现金与额度状态分离、核对、丢响应恢复、已准备请求首次提交恢复。订单列表复用消费者退款概况投影，不在 UI 修改支付状态。

本地验证：`management.persistent.e2e-spec.ts` 的 7 个真实 PG/HTTP 场景、`connections.metadata.e2e-spec.ts` 的 2 个无外部请求配置场景、`management.browser.e2e-spec.ts` 的 9 个真实 Admin/API 场景均已有通过证据。覆盖权限、默认初始化保留自定义、字段投影、分页/状态过滤、真实存储故障、发放并发/回滚/消费、丢响应刷新重试、CMS发布下线、菜单/健康错误及窄屏。上述浏览器测试需要显式 `RUN_MANAGEMENT_BROWSER=1`，使用随机 schema、合成账户与本机 Chrome；测试结束清理进程/schema。

`refunds.browser.e2e-spec.ts` 的 5 个真实 Admin/API/PG 场景覆盖无意外提交、现金待定/额度保留、丢响应、数据库提交占用失败后的同键恢复、现金成功但额度结算失败、周期来源、权限和窄屏。仅 Provider 协议使用合成替身，实际退款/账本/持久化路径保持完整；显式 `RUN_REFUNDS_BROWSER=1` 运行。

`connections.browser.e2e-spec.ts` 原有 7 类真实 Admin/API/PG 场景覆盖基础 10 个动态 profile、密钥保持/替换/清除且不在 DOM 或浏览器存储回显、真实 CAS 冲突保留非密钥草稿并重读再保存、同端口实际应用重启、只读账户、390px 与无配置加密密钥，这些协议未变的证据继续复用。新增 1 项定点浏览器验收遍历六个原生 AI profile 并通过实际加密 API 保存兼容连接；`ai-connections.persistent.e2e-spec.ts` 的 8 项验证覆盖真实 SDK 本地构造、缺项和缺 SDK、业务别名、秘密投影、PostgreSQL 保存与重启、共享 NativeAIClient/wrapper、禁用与未知路由拒绝。显式 `RUN_CONNECTIONS_BROWSER=1`，独立 fixture 使用合成密钥，结束后释放 localhost:4323 与随机 schema，未调用远端模型。Admin 类型、定点 lint 和 production-mode build 的已有证据保留；新增 Server 源码及测试类型、lint 通过。
