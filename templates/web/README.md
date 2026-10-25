# Next.js Web Template

基于 Next.js 与 next-intl 的通用前台消费者模板，包含中英文页面和现有登录、账户入口，通过 `fe-auth`、`fe-http-client` 的公开包接入服务。这里只提供现有通用页面，不包含图片或视频业务。

## 独立项目使用

使用已核验版本的 Zucker CLI 初始化 Web 项目。CLI 负责把模板开发用的 `workspace:*` 换成固定制品版本；不要直接复制未转换的 manifest 并当作独立项目安装。

1. 在生成项目目录执行 `pnpm install`，保存本项目 lockfile。
2. 将 `.env.example` 复制为 `.env.local`。`API_URL` 是服务端 API 完整基址，默认 `http://localhost:4200/api`，包括后端 `/api` 前缀；它不是浏览器公开变量。
3. 启动本项目对应的 Server，再执行 `pnpm dev`。Web 默认开发端口 `4202`；访问 `/zh` 或 `/en`，浏览器的 `/api/*` 请求由 Next.js 转发到配置的 API 基址。
4. 执行 `pnpm lint`。Next.js 开发启动会生成 `next-env.d.ts` 与路由类型；之后可执行 `pnpm exec tsc --noEmit` 检查类型。

国际化配置、翻译 JSON、PostCSS、Tailwind 主题和 ESLint 配置均随项目提供，不依赖 Framework 根目录。当前 `pnpm start` 使用 Next.js 的默认监听规则（`PORT` 或 `3000`）；部署时显式选择端口。`API_URL` 的 rewrite 配置也需纳入部署构建/运行配置。

Next.js 生成的 `.next`、`next-env.d.ts`、本地环境文件不属于模板源资产。账户功能仍需真实 Server、持久化和权限接入；本次配置完善不代表新 CLI 制品已经发布或生产部署已验证。

配置回归使用 Node.js 22.22 或更高版本执行 `node --test config.test.mjs`，只核对本地配置，不启动应用或调用真实服务。

## 可选站点分析

新模板默认 `SITE_CONFIGURATION_SOURCE=server`，从 `API_URL/site/public/integrations` 读取 Server 已应用的公开配置。管理员在连接设置中保存后，重启 Server 应用新版本；Web 重新加载页面即可读取，不需要为连接 ID 重新构建。Server 只返回分析、广告、联盟和客服的公开字段及版本，禁用连接不返回其 ID，不返回其他运行环境或秘密。配置服务失败或响应非法时关闭脚本，不回落到旧 Web 环境重新启用；账户页面继续排除所有营销 SDK。

明确选择 `SITE_CONFIGURATION_SOURCE=environment` 时，沿用本 Web 进程的 `.env.example` 字段。Google Analytics、Clarity、Plausible、OpenPanel、Vercel Web Analytics 的总开关与对应服务开关都须启用；默认全部关闭，单独填写 ID 不加载脚本。这两种配置来源不能混为“都已生效”。

Plausible 填本网站设置页提供的当前脚本 URL；Vercel 填已启用 Analytics 项目给出的同源脚本路径，模板不创建其平台服务。脚本由 Next Script 在页面可交互后加载并按稳定 ID 去重；使用供应商自己的页面跟踪，不叠加一套手动 pageview。

这些是整页加载时的站点开关；改变或停用配置后重新加载页面。移除已执行的脚本不等于撤回其运行能力。应用自行决定访客许可、敏感页面范围与供应商同意信号，模板不会替用户自动同意或调用 identify。可通过组件的 `nonce` 接入应用 CSP。

本连接能力仍为本地源码新增，需消费包含 `@zucker-framework/fe-analytics/site-analytics` 的固定制品；旧版本不一定提供该入口。配置映射和来源回归：`node --test site-integrations.test.mjs site-analytics-config.test.mjs site-connections-config.test.mjs`（11项）。4项真实Chrome场景验证10家连接的加载/去重、账户整页隔离、保存后的停用、接口故障及非法响应；使用本地HTTP替身并拦截所有外部供应商请求。第三方账号的实际报告仍需供应商侧验证；广告、推荐和客服连接见下节。

## 可选广告、推荐和客服连接

这部分使用独立的 `@zucker-framework/fe-site`，默认全部关闭。`.env.example` 列出总开关及 AdSense、Affonso、PromoteKit、Crisp、tawk.to 的公开配置；秘密和用户标识不会作为客户端属性传递。应用根据自己的访客许可与页面政策启用。

`SiteConnections` 只在公共页面挂载。现有 `AccountLink` 进入账户页面时打开新 document；登录、注册、恢复、工作台和账户页面不会挂载 SDK。新增账户链接或程序跳转时保留这个整页边界。删除脚本不能卸载已执行的 SDK，停用或改变配置后应重新加载页面。

根路径 `/ads.txt` 与页面读取同一配置来源。已启用且有效的 AdSense publisher 返回纯文本声明；明确关闭时返回404，配置服务失败或响应非法时返回503，不发布占位账号或旧环境中的声明。

结账归因使用 `readReferral` / `readBrowserReferral` 读取官方 cookie/global，再在服务端用 `referralMetadata` 重新校验。将白名单结果传给 `HostedCheckoutService.create({ ..., providerMetadata })`；不外传私有 `fulfillmentData`、任意浏览器 metadata 或原始 `atp` / `via` 参数。Affonso 有 Stripe/Creem 官方 metadata 协议；PromoteKit 已核对的是 Stripe 协议。当前 PayPal Orders 接口不接受任意 metadata。脚本加载本身不证明佣金归因成功。

安装后可查看本项目 `node_modules/@zucker-framework/fe-site/README.md` 和包内公开类型，核对所安装版本的接口及渠道协议；独立项目不需要 Framework 仓库中的 packages 目录。新包需要完成不可变制品交付后再供正式消费者使用。

## 购买与账单

未指定受保护返回地址时，登录进入真实 `/account`，提供账户资料、账单、积分和文件入口。旧 `/dashboard` 地址按当前语言跳转到该账户页；模板不展示未接数据的统计卡片或将已有数据统一说成“暂无数据”。消费者需要业务工作台时再提供自己的指标与页面。

- `/pricing` 读取 Server 的公开商品目录；未配置套餐时显示真实空状态。金额、积分、有效期和可用付款方式均由服务端提供。
- `/billing/orders` 展示当前账户的分页订单；`/account` 提供账单入口。
- `/billing/return?order=…` 读取本人订单并核对供应商状态。只有服务端返回已付款且已履约才显示完成；PayPal 扣款需要用户点击带金额的明确确认按钮，读取和核对不会代替该操作。

创建订单只提交 `offerId`、`providerId` 和渠道支持的受控 `referral`。浏览器先向服务端确认当前账户，再为本账户和所选套餐/渠道保存随机购买编号，并通过 `Idempotency-Key` 发送；不以尚未恢复的本地用户状态创建匿名编号。网络错误或页面刷新后的相同选择复用该编号，不自动创建第二笔购买。服务端明确确认完成或未支付后结束该次记录，下一次用户主动购买才使用新编号。浏览器存储受限时，当前页面仍保留同一重试编号。

回跳的 Stripe `session_id`、PayPal `token`、Creem `checkout_id` 只按已读取订单的渠道传给核对接口，服务端重新查询并验证关联；`success` / `paymentStatus` 等 URL 参数不能证明付款。账单路径沿账户整页导航边界，不加载广告、分析或客服 SDK。

合成浏览器契约位于 `e2e/web/billing.spec.ts`。运行时使用隔离的本地 Web、`localhost` 启动地址及合成 API/供应商拦截；真实 Billing HTTP/PostgreSQL 与真实支付供应商验证分别记录，浏览器假数据不替代它们。


### Optional provider sign-in and connected accounts

The login page asks `/api/authorize/oauth/providers` which Google/GitHub modes the Server actually enables. Missing configuration leaves password/email flows available without placeholder social buttons. Google One Tap's SDK loads only when the user requests it; its nonce is generated and stored by the Server. Code-flow callbacks arrive at the dedicated localized `/oauth/callback` page, which clears the handoff fragment and waits for explicit confirmation. Marketing analytics are excluded from this route too.

The account page lists connected identities and starts explicit linking while authenticated. Disconnect failures preserve the existing connection, and disconnecting the provider that authenticated the current session returns the user to login. The Server enforces ownership, session binding, same-origin mutations and the final sign-in-method constraint; the UI does not infer those guarantees from a provider profile.

### Account API keys

The account page creates, lists and revokes the signed-in user's keys. The form stays unavailable until the account identity has loaded, so a late `/authorize/me` response cannot replace the panel and lose a freshly created secret. Creation offers 7, 30, 90 or 365 days (30 by default) and the fixed `account:read` scope. These keys read only `GET /api/v1/account`; they do not replace the browser's JWT session for account management or administration.

A complete secret exists only in the creation response and component memory. It is displayed in a labeled read-only field, with an explicit copy action and a dismiss action. The app does not put it in local storage, request URLs or logs. Closing the panel, changing accounts or reloading discards the display; subsequent lists contain only the prefix and metadata. Create/revoke failures remain retryable, and failed revocation leaves the key listed. If a key was lost before copying, revoke it and create a replacement rather than trying to retrieve it again.

## 账户积分

账户积分摘要与批次分别展示可用、已冻结和退款待处理额度。`refundBlocked` / `refundBlockedAmount` 只表示尚未被真实hold冻结的退款隔离部分，不与冻结或过期额度重复计算；`refund_pending` 批次可用为0，即使其全部剩余额度已经冻结、待处理金额显示0，状态仍可保持退款待处理。界面使用API的 `available` / `availableAmount`，不根据账面余额推算可消费额度。中英/390px实际页面与Admin余额/批次各1项定点已验证；该UI证据不替代后端消费阻断回归。

## 个人私有文件

`/{locale}/account/files` 从账户页进入，展示本人每页 20 条文件记录，提供上传、未完成上传核验、短效下载、删除/清理重试和允许来源的 HTTPS 链接转存。默认单文件上限 10 MiB；页面读取 Server 返回的实际限制与转存开关，默认关闭的转存不显示提交表单。文件名、URL 与内容不写入浏览器存储，上传/转存重试只保留账户绑定的摘要和随机请求编号。刷新后重新选择同一文件会先查原请求；已就绪文件不会再次上传。

下载入口向 Server 申请短效票据，在组件内存保留 URL 和到期时间，再从 URL 解析 token，以 POST JSON 正文发送到无查询参数的公开下载端点取得附件。默认下载不将票据放进访问 URL；票据不写入浏览器存储或页面导航历史，失效票据不会触发账户刷新/退出。删除是永久操作，清理失败保留 tombstone 并提供重试；“核对上传”不会复活已删除文件。当前头像文件需先到账户设置移除头像。

真实 Web/API/PostgreSQL/本地对象验收位于 Server `test/files.browser.e2e-spec.ts`，显式 `RUN_FILES_BROWSER=1`，使用 localhost:4324、本机 Chrome、随机 schema 和独立临时对象目录；URL 来源下载仅替换外部协议，文件持久化、签票、授权、核验与清理都走真实实现。覆盖丢响应刷新恢复、下载字节/过期、不因票据 401 退出、待核验恢复、清理失败、头像占用、转存来源与关闭状态、分页和英文 390px。

上述文件入口的7类真实浏览器场景已通过；Server新增14项PG/HTTP及最终POST票据兑换3项定点复验通过，复验不累加为新增用例。真实S3桶与外部URL来源未调用，自动后台恢复、大文件/分片上传未宣称完成。源码与模板本地验证不等于本批I6固定制品消费验收。

## 内容、文档与站点设置

- `/{locale}/blog`、`/blog/[slug]`、`/blog/category/[slug]` 展示数据库中的已发布博客和分类。
- `/{locale}/docs`、`/docs/[...slug]`、`/docs/search?q=…` 提供文档列表、正文目录与持久化全文检索。
- 普通页面位于 `/{locale}/[...slug]`；应用保留路径不能作为内容地址。
- `/{locale}/content/manage` 是需要 Server `content:manage` 权限的内容工作台，包含草稿、发布、取消发布、归档/恢复、博客分类和站点设置。路由 Cookie 仅用于登录提示，权限由每次 API 请求确认。

草稿和公开版本分离：保存标题、正文或地址不会改变线上版本；作者显式发布已保存版本后才替换。编辑器存在未保存修改时禁用发布，所有保存/状态变更携带预期版本，冲突要求重新加载。正文支持安全 Markdown，不执行 HTML/MDX。结构块当前通过带校验的 JSON 编辑器编辑，禁用块从公开快照和检索文本中移除。

品牌、双语导航/页脚、默认外观和主题名读取 Server `ConfigService` 的 `site.publicSettings`。仅公开字段投影到浏览器；当前命名主题注册表只有 `default`，未知主题回退到它。公开页面支持浅色/深色/跟随系统；账户、账单及内容工作台保持深色并沿用 SDK 隔离。导航及 Markdown 链接进入新 document，避免公开站点 SDK 跟随至私有页面。

页面 canonical 与 Open Graph 来自公开快照和 Server 配置的 `WEB_URL`。根 `/sitemap.xml` 为动态索引，`/sitemaps/[page].xml` 每页读取 1000 项，排除未发布及 noIndex 内容；`/robots.txt` 排除账户、账单、管理和文档搜索。`SITE_URL` 是 Web 在站点设置不可用时使用的固定源站回退，应与 Server `WEB_URL` 一致，不从请求 Host 推导。内容接口故障显示真实错误，不伪装为空列表或静态文章。

真实 PostgreSQL/HTTP 契约位于 Server `test/content.persistent.e2e-spec.ts`。真实 Web 浏览器契约位于 `test/content.browser.e2e-spec.ts`，显式设置 `RUN_CONTENT_BROWSER=1` 和已隔离的 `TEST_DATABASE_URL` 后运行；它启动 localhost:4319 上的 Next、随机端口 API 和随机数据库 schema，使用本机 Chrome，拦截外部请求并在结束时删除测试 schema。普通模板测试默认跳过该浏览器套件，不安装或下载浏览器。
