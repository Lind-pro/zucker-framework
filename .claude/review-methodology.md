# zucker-framework 代码审查方法论

## 教训

40 轮审查未发现 `salt` 字段不存在于 Prisma schema、`createTime` 类型不匹配等简单问题。
根因：审查只在代码层面进行，从未对照数据库 schema 交叉验证。

## 审查层次（必须按顺序执行）

### Layer 1: Schema-Code 合同验证（最高优先级）

**每次审查必须首先执行此步骤。**

1. 读取 `templates/server/prisma/schema.prisma`
2. 对每个 `db.model('X').create/update` 调用：
   - 列出代码传入的所有字段
   - 对照 Prisma schema 中 `model X` 的字段定义
   - 检查：
     - [ ] 是否有 schema 中不存在的字段？（如 `salt`）
     - [ ] 必填字段是否都传了？（如 `typeId`）
     - [ ] 类型是否匹配？（Boolean vs number, DateTime vs number, String vs number）
     - [ ] 字段名是否完全一致？（`type` vs `typeId`）
3. 对每个 `db.model('X').findMany/findUnique` 的 where 条件：
   - 复合唯一键语法是否正确？
   - 字段名是否存在于 schema？

### Layer 2: 双模式 E2E 验证

**不能只用 InMemoryAdapter 测试。**

1. InMemoryAdapter 模式：快速功能验证
2. Prisma 模式：在有数据库的环境下验证
   - 至少执行 `npx prisma validate` 确认 schema 合法
   - 如有条件，用真实 PostgreSQL 跑一次 bootstrap + login
3. 如果没有真实数据库，至少做"Prisma dry-run"：
   - 用 `npx prisma generate` 生成 client
   - 检查生成的类型定义与代码是否兼容

### Layer 3: 代码逻辑审查

**在 Layer 1 和 Layer 2 通过后才进行。**

- 边界条件（空数组、null、负数、超大值）
- 事务安全（级联操作是否在 $transaction 中）
- 异常处理（catch 是否吞掉了不该吞的错误）
- 并发安全（READ-MODIFY-WRITE 模式）
- 敏感数据泄漏（password/salt 是否在返回值中被过滤）

### Layer 4: 运行时对账

**用真实请求验证，而非只读代码。**

1. 启动 server
2. 用 curl 执行完整业务流程
3. 检查 server 日志中是否有 WARN/ERROR
4. 对每个 API 返回值检查：是否包含不该有的字段？是否缺少期望的字段？

## 审查 Agent Prompt 模板

```
你是 zucker-framework 的审查员。

**第一步（必做）：读取 Prisma schema**
读取 templates/server/prisma/schema.prisma，记住每个 model 的字段名、类型、是否必填。

**第二步：对照验证**
对要审查的文件中每个 db.model('X').create/update 调用，
逐字段对照 schema 检查：字段是否存在？类型是否匹配？必填字段是否遗漏？

**第三步：才做逻辑审查**
在第一步和第二步没有问题后，再检查业务逻辑。
```

## 常见陷阱

| 陷阱 | 为什么危险 | 如何避免 |
|------|-----------|---------|
| InMemoryAdapter 测试全绿 | 它不校验字段和类型 | 必须同时对照 Prisma schema |
| 只读代码不跑程序 | 代码"看起来对"不等于"运行时对" | 必须实际启动并发请求 |
| 审查 prompt 只关注逻辑 | Agent 不会自发检查 schema 兼容性 | prompt 必须明确要求 schema 验证 |
| 修了表面没修根源 | 在 main.ts 改字段名，但 UserService 里还是错的 | 修根源（Service 层），而非调用方 |
| 多轮审查同质化 | 每轮审查用同样的方法论，找同类型 bug | 每轮审查必须有不同的检查维度 |
