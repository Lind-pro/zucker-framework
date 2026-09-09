# Zucker Framework 跨项目包引用调研

调研日期：2026-09-09。依据：TypeScript、Node.js、pnpm、Turborepo、npm、Changesets 官方资料，以及当前工作区的清单、配置和脚本。

发布命名更新：用户随后创建了 npm 组织 `zucker-framework`，实际发布采用
`@zucker-framework/*`。下文保留调研时的 `@zucker/*` 示例；当前包名及发布步骤以
[发布文档](../package-release.md)和各包清单为准。

## 结论

推荐采用 **基建 monorepo 集中开发，业务项目通过 npm 兼容 registry 安装版本化的 `@zucker/*` 包**。基建内部继续使用 pnpm workspace 和 Turborepo；版本与变更记录继续使用 Changesets。不同业务项目可以保持独立仓库、独立 lockfile 和独立升级节奏。

选择这个方案的前提是：这些业务项目需要独立交付，基建能力需要被重复使用。如果应用与库始终一起修改、一起交付，同一个业务 monorepo 内使用 workspace 也合理。是否同仓与是否发布包是两个独立决定。

当前仓库已经具备这条路线的主要组成部分。优先工作应当是补齐跨仓库交付契约，无需先更换工具或把所有业务仓库合并。

## 1. 各层工具分别解决什么问题

| 层次 | 职责 | 对本仓库的建议 |
| --- | --- | --- |
| Monorepo | 多个包共同开发、审查和修改 | 保留 `packages/*` 与 `templates/*` 的分工 |
| pnpm workspace | 安装依赖、链接本地包、生成依赖锁定信息 | 仓库内显式使用 `workspace:` |
| Turborepo | 按依赖关系调度任务、缓存构建结果 | 保留；包依赖必须反映在各自清单中 |
| TypeScript / 构建器 | 检查类型，生成可运行 JS 和类型声明 | 对外包提供编译产物，并验证消费者解析方式 |
| Changesets | 记录变更、计算版本、更新关联依赖和 changelog | 保留，但明确独立版本、linked、fixed 的选择 |
| npm 兼容 registry | 存储、分发、授权访问版本化包 | 跨仓库交付的正式入口 |

TypeScript project references 是跨 TS 子项目的组织与增量编译机制，不负责安装或分发包。已有 Turbo 与包构建脚本时，只有出现具体的类型检查性能或项目边界需求，才需要进一步引入 `tsc -b`；并不是 monorepo 的必选项。[S3][S5][S12]

## 2. 按使用阶段选择引用方式

| 场景 | 推荐方式 | 需要理解的边界 |
| --- | --- | --- |
| 基建包之间、仓库内模板应用 | `workspace:*` 或有意选择的 workspace 范围 | 依赖真实 workspace 包，由包管理器完成链接 |
| 独立业务项目常规开发与生产交付 | registry 中的明确版本 + 提交 lockfile | 业务项目自行决定何时升级 |
| 跨仓库验证尚未发布的修改 | 编译并打包为 `.tgz`，安装到独立临时消费者 | 更接近正式安装；涉及的内部依赖也必须可解析 |
| 需要即时反馈的跨仓库联调 | 临时本地 `file:` / link，配合库的 watch 构建 | 检查 peer 和重复实例；不能替代发布产物验证 |

不建议把 Git 仓库地址、Git submodule、复制源码，或 `../../zucker-framework/packages/.../src` 作为这些基础库的常规交付方式。它们能用于特定开发安排，但会让消费者依赖源码布局、构建环境或另一份检出目录。registry 包更适合独立升级和可复现安装。

pnpm 的 `workspace:` 是本地解析约束。打包或发布时，pnpm 会把它转换为普通版本声明。例如，假设目标包版本为 `1.2.3`：

| 源码清单中的声明 | `pnpm pack` 生成的包清单 |
| --- | --- |
| `workspace:*` | `1.2.3` |
| `workspace:^` | `^1.2.3` |
| `workspace:~` | `~1.2.3` |

上述版本仅用于说明协议。实际版本应来自包清单与经过验证的发布清单。转换后的包可以由其他项目使用 npm、pnpm 或兼容客户端安装；消费者不必采用与基建相同的 monorepo 工具。[S1]

本地 `.tgz` 测试还应注意：只安装顶层包，并不会自动把该包依赖的其他未发布包也带上。应准备依赖闭包，或在隔离的测试 registry 中验证解析。需要 peer 的库采用目录联调时，pnpm 官方建议优先考虑 `file:` 而不是 `pnpm link`，因为前者更适合按消费项目解析 peer。[S2]

## 3. 对外发布包应具备的契约

### 3.1 明确入口与产物

- 通过 `exports` 定义根入口及确实需要的子入口；消费者按公开名称导入。
- 发布可执行 JS 和匹配的类型声明。是否同时发布 ESM/CJS，由实际支持的消费者决定。
- 使用 `files` 控制分发内容，包含必要的声明、运行时资源、README 和许可证；检查 tarball 中实际存在的文件。
- 在相关包中声明支持的 Node.js 版本。根目录的 `engines` 不会成为每个已发布包的运行时契约。
- 业务环境配置由消费者显式传入；产品 schema、Prisma 生成客户端、凭据和部署策略不应成为通用库的隐式前提。

Node.js 推荐通过 `exports` 明确包接口。给已有包补 `exports` 会限制此前能访问的子路径，因此应先调查消费者，再决定兼容导出或迁移版本。[S4]

当前 `@zucker/core` 已有可参考的布局：ESM 使用 `.mjs` / `.d.mts`，CJS 使用 `.js` / `.d.ts`，分别配置 `import` / `require` 条件。这里的 `.js` 是否是 CommonJS，取决于该包自己的 `type` 和包作用域，不能只看扩展名或仓库根配置。

### 3.2 TypeScript 检查要覆盖消费者

TypeScript 官方明确建议：不要用 `paths` 将 monorepo 包名直接指向兄弟包源文件。它会绕过真实的 `node_modules` 包查找和 `exports` 等规则，而且 `paths` 本身不改写发出的 import。[S6]

本仓库采用打包器，因此根配置的 `moduleResolution: bundler` **不能单凭这个设置就判定错误**。官方允许打包库采用这种配置，但指出两个条件：外部依赖的导入要能被消费者解析，类型声明也必须具有与 JS 相容的结构。一次源码类型检查不能证明 ESM 与 CJS 两套输出均兼容。[S5]

建议为发布包设置小型消费者检查：

- Node ESM 消费者：从安装后的包导入并运行最小行为。
- 如果承诺支持 CJS：增加 `require` 消费者。
- 对安装后的声明执行 TypeScript 检查，覆盖承诺支持的 Node 模块解析方式；类型夹具使用 `skipLibCheck: false`。
- 前端包补实际支持的 bundler / 浏览器消费者；不需要让所有后端库都跑浏览器测试。
- 如果承诺同进程混合 ESM/CJS，检查类身份、注入 token 与有状态对象是否因不同入口而重复。

新版本 Node 可以直接执行部分 TypeScript，这不意味着对外库应默认发布裸 `.ts`：官方说明其类型剥离不读取 `tsconfig.json`，不进行类型检查，并拒绝处理 `node_modules` 下的 TypeScript。对当前面向 Node 与前端的通用基建，编译后的 JS + 声明是更稳妥的默认交付。[S7]

### 3.3 依赖要由真正使用它的包声明

| 依赖种类 | 常见归属 | 原因 |
| --- | --- | --- |
| 包运行时直接使用的普通库 | `dependencies` | 消费者安装时需要它 |
| NestJS、React 等宿主框架 | `peerDependencies`，开发检查按需配套 dev 依赖 | 声明与消费项目宿主的兼容关系 |
| TypeScript、测试框架、构建器 | `devDependencies` | 用于维护和构建包 |
| 可选宿主或适配器 | 可选 peer 或独立入口/包 | 非使用者不必承担对应依赖；入口也必须能在缺少它时安全加载 |
| `@zucker/*` 兄弟包 | 根据运行时职责选择 dependency 或 peer | 需要共享实例、上下文或注入身份时，重点检查版本与实例一致性 |

不要把所有兄弟包机械地改成 peer，也不要把 NestJS、React 或需要保持身份一致的兄弟运行时打进另一份 bundle。`external` 只控制打包行为，不代替依赖声明。peer 范围应表达验证过的兼容范围；通常不应无理由限定到单个 patch。[S8]

## 4. Registry 和版本管理

### 4.1 Registry 选择

如果基建是组织内部代码，默认采用私有 npm 兼容 registry；如果计划公开，仍采用同一种包交付模型，仅访问策略不同。

| 选择 | 适合情况 | 对 `@zucker/*` 的影响 |
| --- | --- | --- |
| npm 私有 scope / 组织 | 希望使用托管服务 | 需要拥有或获得 `@zucker` scope 的相应权限 |
| GitHub Packages | 权限管理主要在 GitHub | npm namespace 关联 GitHub 用户或组织；必须核实能否使用 `zucker` |
| Verdaccio 或现有企业 registry | 希望自行管理命名空间和访问策略 | 可保留现有命名，但需承担存储、备份与服务维护 |

GitHub 官方的发布示例要求包名使用拥有它的用户/组织 namespace。因此不能仅因代码位于 GitHub，就假设现有 `@zucker/*` 可原名直接发布到 GitHub Packages。[S10]

配置时只把 `@zucker` scope 指向选定 registry，认证通过本地凭据或 CI secret 提供。消费者使用只读权限，发布流程单独管理写权限。这里不替用户选择实际服务或更改命名空间。[S10][S14][S15]

### 4.2 版本策略

推荐以包独立版本为默认，只对需要一起升级的紧密组合使用 `fixed`。

- `fixed`：组内包一起升到相同版本并发布。
- `linked`：参与本次版本变更的包协调版本号，不保证所有成员都升版和发布。
- 独立版本：每个包按自己的变更和依赖关系升版，适合能力与稳定程度不同的模块。

当前配置的五个 `linked` 组按技术层分组。技术层相近不必然表示必须同步版本；应根据消费者是否需要一起升级来重新评估。这是策略建议，不是断言现有配置无法工作。[S9][S11]

当前很多包处于 `0.x` / RC 阶段，建议业务应用使用经过验证的精确版本并提交 lockfile，CI 使用 frozen lockfile 安装。版本范围与 lockfile 作用不同：前者决定允许更新到哪里，后者固定本次安装的依赖图。成熟稳定的库可逐步承诺 1.x API，内部依赖范围再按实际兼容性决定。[S1][S13][S16]

发布版本不可覆盖。RC 使用预发布 tag；业务项目升级到具体版本后运行自己的集成检查。回退包版本与 lockfile 后重新构建应用；涉及 schema 或数据变化的回退由业务项目另外制定。框架发布不触发所有应用同时升级。[S16]

## 5. 当前仓库的证据与缺口

以下为静态读取结果，包含工作区现有改动，不表示已验证 registry 中的发布状态。

| 观察 | 本地证据 | 含义与建议 |
| --- | --- | --- |
| 已采用 pnpm、Turbo、Changesets | [根清单](../../package.json)、[workspace](../../pnpm-workspace.yaml)、[Turbo](../../turbo.json) | 工具路线适合继续使用 |
| `packages/*` 下有 51 个包，现有 RC 产物脚本选择 12 个 | [产物验证脚本](../../scripts/verify-package-artifacts.mjs) 的 `packageNames` | 现有检查不能代表所有包均已具备跨项目交付能力；显式管理发布包清单及依赖闭包 |
| 19 个包声明 `exports`，其余 32 个没有，其中包括 CLI | 各包 `package.json`；[core](../../packages/core/package.json) 与 [ai](../../packages/ai/package.json) 可作对照 | 面向外部导入的库需逐包确认入口；CLI 的 binary 入口与库入口应分别判断 |
| CLI 最小脚手架含 `workspace:*`、`extends: ../../tsconfig.base.json` 和 NestJS 11 | [init.ts](../../packages/cli/src/commands/init.ts)；[common peer](../../packages/common/package.json) 为 NestJS 12 | 在独立目录生成、又无对应 workspace 和父配置时，安装/编译前提不成立；宿主范围也不匹配。应生成可独立安装的版本化项目 |
| CLI 找到本仓库模板时直接复制 | [init.ts](../../packages/cli/src/commands/init.ts)、[server 清单](../../templates/server/package.json) | 模板里的 workspace 依赖需要在导出为独立项目时转换；内部模板不能直接等同于外部交付模板 |
| 已有临时 npm/pnpm 消费者，npm 检查 ESM/CJS，pnpm 检查 peer 与 ESM | [产物验证脚本](../../scripts/verify-package-artifacts.mjs) | 这是值得保留的基础；本次未运行这些检查 |
| 现有产物脚本没有消费者 `tsc` 检查，也未验证 CLI `init` 生成项目 | 同上 | 运行时导入成功不能证明声明文件或独立脚手架能用 |
| npm/pnpm 夹具一次安装全部选定包，pnpm 还将内部包 override 为 tarball | 同上 | 能验证一组组合，但可能掩盖单包漏声明依赖，且不证明真实 registry 解析；补最小依赖安装与 registry 消费检查 |
| 单元测试将 `@zucker/*` 映射到源码 | [vitest 配置](../../vitest.config.ts) | 有利于验证源码行为；产物入口与声明兼容仍需独立检查 |
| 默认根 TS 配置为 bundler 解析，Node 兼容承诺分散 | [TS 配置](../../tsconfig.base.json)、各包 `engines`、CI | 增加消费者矩阵，分别明确维护工具链与发布包的最低运行时 |
| 同时存在 `release` 和 `pack:rc` / `publish:rc` 路线 | [根清单](../../package.json)、[发布流程](../../.github/workflows/release.yml) | 后续统一对外发布入口，使版本决策、验证和上传不会分叉 |

根清单当前为 `pnpm@11.25.0`、TypeScript `^6.0.3`、Turbo `^2.10.12`、Changesets `^3.0.1`。这只是当前项目选型，不是让所有消费项目复制同一套版本的要求。官方 pnpm 页面本次已跳转至当前文档；后续落地版本敏感命令时仍以仓库锁定版本为准。

现有 [发布文档](../package-release.md) 已经规定不可变版本、校验和、独立消费者以及业务项目独立升级。应在这个基础上扩展覆盖面，并以实际 manifest 为版本依据。

## 6. 建议的落地顺序

1. **确定第一批对外包与支持环境。** 列出必需依赖、peer、Node 与 TypeScript 最低支持范围、ESM/CJS、前后端适用范围，以及经验证的组合；先从有消费者的能力开始。
2. **确定能保留 `@zucker/*` 的 registry。** 评估 scope 权限、消费认证、发布权限和备份要求，形成可审查的配置方案。
3. **打通一个完整的外部消费路径。** 从包产物安装开始，验证一个真正独立的 Node 项目；前端需求则另选一个最小前端消费者。保留源码单测，增加产物类型检查。
4. **修正独立项目交付入口。** CLI / 导出模板生成版本化依赖和独立配置；若维护共享 TS 配置，做成明确的配置包或直接生成所需配置，消除对框架检出目录的依赖。
5. **统一版本与发布流程。** Changesets 负责版本/changelog；现有审计产物流程负责打包、检查和实际上传。只验证与本次变更相关的消费者组合，发布阶段再执行必需门禁。
6. **建立业务项目升级流程。** 明确变更说明、精确版本与 lockfile 更新、集成验证、发布与回退责任，逐步推广到更多包。

这是后续实施建议。本次只完成文档调研与静态核对，没有更改业务或库代码、执行构建、安装依赖、访问私人 registry、发布包或修改其他项目。未验证的项目包括真实发布权限、实际 registry 版本可用性、外部安装结果、类型编译结果及应用运行兼容性。

## 官方资料

- [S1 — pnpm Workspace](https://pnpm.io/workspaces)：workspace 本地约束、打包转换、版本管理。
- [S2 — pnpm link](https://pnpm.io/cli/link)：link 与 `file:`、peer 解析差异。
- [S3 — Turborepo Internal Packages](https://turborepo.com/docs/core-concepts/internal-packages)：即时编译、预编译、可发布包的区别。
- [S4 — Node.js Packages](https://nodejs.org/api/packages.html)：`type`、`exports`、条件导出和入口兼容性。
- [S5 — TypeScript Choosing Compiler Options](https://www.typescriptlang.org/docs/handbook/modules/guides/choosing-compiler-options.html)：库与应用的配置区别、bundle 外部依赖、双格式输出。
- [S6 — TypeScript Modules Reference](https://www.typescriptlang.org/docs/handbook/modules/reference.html)：`paths` 不改写 emit，不应代替 workspace 包解析。
- [S7 — Node.js TypeScript](https://nodejs.org/api/typescript.html)：类型剥离、`tsconfig` 与 `node_modules` 限制。
- [S8 — npm package.json](https://docs.npmjs.com/cli/v11/configuring-npm/package-json)：文件、依赖、peer 和运行环境声明。
- [S9 — Changesets Configuration](https://changesets.dev/guide/config)：版本分组及内部依赖配置。
- [S10 — GitHub npm Registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry)：namespace、认证和包权限。
- [S11 — Changesets Linked Packages](https://changesets.dev/guide/linked-packages)：linked 与固定组行为区别。
- [S12 — TypeScript Project References](https://www.typescriptlang.org/docs/handbook/project-references.html)：项目拆分与增量构建。
- [S13 — pnpm install](https://pnpm.io/cli/install)：lockfile 和 frozen 安装。
- [S14 — npm Private Packages](https://docs.npmjs.com/about-private-packages/)：私有 scope 与访问控制。
- [S15 — Verdaccio Introduction](https://www.verdaccio.org/docs/what-is-verdaccio/)：私有 npm 兼容 registry。
- [S16 — Semantic Versioning](https://semver.org/)：公共 API、0.x、预发布与版本不可变。
- [S17 — Changesets Getting Started](https://changesets.dev/guide/getting-started)：变更记录、版本和发布职责。
