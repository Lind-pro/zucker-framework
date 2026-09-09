# Prisma Base Schemas

zucker-framework 的基础数据库 Schema 文件。

消费项目将这些文件复制或 symlink 到自己的 `prisma/schemas/` 目录。

## Schema 文件

| 文件 | 说明 | 对应包 |
|------|------|--------|
| auth.prisma | 用户、角色、权限、维度、Token、OAuth、菜单 | @zucker-framework/auth |
| logging.prisma | 访问日志、操作日志 | @zucker-framework/logging |
| dictionary.prisma | 数据字典、字典项 | @zucker-framework/dictionary |
| config.prisma | 系统配置 | @zucker-framework/config |
| notification.prisma | 通知模板、订阅者、通道、历史 | @zucker-framework/notification |
| credit.prisma | 积分、积分事务 | @zucker-framework/credit |
| rule-engine.prisma | 规则、条件、动作、告警 | @zucker-framework/rule-engine |

## 使用
待 Phase 4 实现。
