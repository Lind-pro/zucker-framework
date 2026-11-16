# 57 包覆盖矩阵

所有包均纳入 manifest/导出与源码依赖扫描；测试列来自本轮源码测试实际结果。问题列为空表示本轮未确认新增问题，不表示逐行审计已证明无缺陷。源码文件数排除命名为 spec/test 的文件，但可能包含测试辅助代码。

| 包 | 扫描源码文件 | Vitest 文件 | 通过 | 跳过 | 确认问题/补充验证 |
| --- | ---: | ---: | ---: | ---: | --- |
| admin | 46 | 17 | 153 | 0 | — |
| ai | 67 | 38 | 360 | 0 | — |
| ai-access | 11 | 9 | 51 | 2 | — |
| ai-tasks | 12 | 6 | 21 | 20 | — |
| auth | 78 | 41 | 370 | 0 | — |
| back-office | 111 | 25 | 288 | 75 | — |
| buffer | 3 | 1 | 29 | 0 | — |
| cache | 13 | 6 | 63 | 1 | R11 |
| cli | 14 | 10 | 88 | 0 | 另 1 项入口 Node 测试通过 |
| cluster | 6 | 3 | 51 | 0 | — |
| common | 24 | 15 | 143 | 0 | — |
| config | 17 | 6 | 65 | 0 | — |
| core | 52 | 39 | 664 | 0 | — |
| create-app | 1 | 0 | 0 | 0 | 薄入口静态检查；复用 cli/create，未打包安装验证 |
| credit | 11 | 10 | 121 | 0 | — |
| crud | 30 | 26 | 507 | 0 | — |
| dashboard | 4 | 1 | 31 | 0 | — |
| datasource | 9 | 6 | 85 | 0 | R04 |
| dictionary | 11 | 4 | 49 | 0 | — |
| event | 18 | 11 | 138 | 0 | — |
| ext-kit | 21 | 1 | 12 | 0 | 另 45 项 Node 测试通过；未跑真实扩展浏览器测试 |
| ext-server | 4 | 2 | 29 | 0 | — |
| fe-admin | 46 | 24 | 199 | 0 | — |
| fe-analytics | 3 | 4 | 33 | 0 | — |
| fe-auth | 8 | 11 | 76 | 5 | R08 |
| fe-blocks | 6 | 2 | 31 | 0 | — |
| fe-form | 16 | 2 | 14 | 0 | — |
| fe-http-client | 8 | 14 | 110 | 0 | R01 |
| fe-permission | 3 | 2 | 17 | 0 | — |
| fe-site | 5 | 5 | 158 | 0 | — |
| fe-storage | 5 | 4 | 25 | 0 | — |
| fe-types | 5 | 1 | 2 | 0 | — |
| feature-flags | 1 | 1 | 7 | 0 | — |
| form | 6 | 3 | 75 | 0 | — |
| gateway | 7 | 3 | 28 | 0 | — |
| i18n | 8 | 4 | 43 | 0 | R02 |
| io | 8 | 3 | 32 | 0 | — |
| logging | 21 | 20 | 151 | 0 | — |
| media | 17 | 17 | 156 | 0 | — |
| monitoring | 19 | 11 | 76 | 0 | — |
| network | 10 | 4 | 43 | 0 | R03 |
| notification | 42 | 27 | 200 | 1 | — |
| payment | 43 | 29 | 530 | 0 | — |
| provider | 11 | 1 | 3 | 0 | R06 |
| queue | 12 | 9 | 69 | 2 | — |
| rate-limiter | 6 | 6 | 44 | 0 | — |
| reference | 8 | 3 | 23 | 0 | — |
| relation | 4 | 2 | 28 | 0 | — |
| rule-engine | 30 | 15 | 249 | 0 | R09 |
| script | 8 | 7 | 131 | 0 | — |
| search | 5 | 2 | 30 | 0 | — |
| storage | 16 | 13 | 193 | 16 | R05 |
| task | 21 | 18 | 102 | 3 | — |
| tenant | 10 | 3 | 48 | 0 | — |
| things | 8 | 5 | 47 | 0 | — |
| timeseries | 5 | 1 | 2 | 0 | R07 |
| tracing | 6 | 3 | 47 | 0 | R10 |

合计：57 包，1,000 个扫描源码文件，556 个 Vitest 文件，6,340 项通过、125 项跳过。另 46 项 Node 用例通过；14 项独立缺陷特征验证通过。

依赖图及 manifest exports 快照见 [structure.json](./structure.json)，各包源码摘要和具体复现结果见 [evidence.json](./evidence.json)。
