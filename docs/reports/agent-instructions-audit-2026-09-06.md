# zucker-framework agent instruction audit

Date: 2026-09-06. Scope: local instructions, skills and developer/CI workflow guidance. No build, commit, push, remote CI dispatch, package/image publication or deployment was performed.

## Official sources

The same current official sources fetched for the 既有消费项目 audit were reused:

- [GPT-6 Astra guidance](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-6-astra)
- [AGENTS discovery](https://developers.openai.com/codex/guides/agents-md/)
- [Skills and progressive disclosure](https://developers.openai.com/codex/skills/)
- [Prompting guidance](https://developers.openai.com/codex/prompting/)

Model-specific guidance supports clearer goals/authorization, auditing conflicting file instructions, task-proportional verification and intentional delegation. It does not guarantee that maximum reasoning, more tool calls or a smaller file makes every task faster. Host/user model settings and global skills were not changed.

## Findings and local changes

- 根 AGENTS 原为约20 KB的包/API手册，CLAUDE又有旧pnpm/Nest/Prisma版本和重复清单。常驻内容改为产品中立边界，命令按实际manifest选择。
- 添加 framework-development/framework-review；包能力索引改为按需参考，不再在每个任务中加载全部签名和样例。
- 原审查方法论要求任何审查先读模板schema、生成Prisma并做E2E。改为数据库相关变更才核对schema/真实adapter；保留 InMemoryAdapter 不能证明SQL约束这一关键教训。
- 删除固定至少5个测试case、固定工具依赖及未经证实的工具速度宣称。保留公共exports、依赖方向、peer身份、生命周期、幂等和持久性契约。
- package-release.md 标注旧RC清单只是历史盘点，以manifest和实际peer范围为准；将过时的既有消费项目/Worker接入指令改为各消费方自己的执行与发布契约。
- CI和手动发布均提前检查指令；保留不可变版本、干净来源、制品校验及dry-run默认。没有发布框架包或修改任何消费方依赖。

## Size and discovery

- Independent root instruction bodies: 23599 -> 4652 bytes; 80.3% reduction.
- Skill/review Markdown: 3410 -> 4522 bytes. The old value includes independent duplicate copies; the new value is canonical skill/reference content, excluding compatibility-link path bytes.
- Discoverable canonical skills: 2. Compatibility links checked: 2.

These are UTF-8 byte measurements, not tokenizer counts or model benchmarks. Root/skill/reference loading differ; total disk reduction is not equivalent to per-turn context savings. New reports and workflow documentation are read on demand.

## Verification

- Official skill-creator quick validation: all 2 skills passed.
- Local checker regression: 10/10 passed, including aliases, broken references, duplicate routing fields, Git visibility and explicit non-Git handling.
- Live local instruction inventory: passed.
- Workflow YAML parsing: 2 files passed. Existing quality gates were inspected for early instruction checks; new standalone checks use read-only permissions and no dependency installs/secrets.
- New JavaScript formatted with the already installed formatter; no dependencies installed. Git whitespace checks passed where a root Git repository exists.
- Source fingerprints matched the initial snapshot for tracked application/package/dependency files.

No application behavior or data schema was changed by this audit, so no application build/browser/dependency-health claim is made. Existing artifact directories, secrets and user settings were not edited. GitHub jobs were not executed remotely; YAML/step checks do not prove hosted runtime success.

## Scope and follow-through checks

Manual rule walkthroughs covered a small local edit, a review, a missing tool/data case and a release/external action. They confirm the intended routing in prose, not independent model performance. New sessions should be used to assess the actual effect on interruptions, repeated checks and completion quality with the same model/settings.

Changes remain local. Revert only this audit's instruction/check/workflow paths to roll back; preserve concurrent source changes. No database migration or production rollback is needed.

See [AGENTS](../../AGENTS.md) and [local workflow](../runbooks/agent-development-workflow.md).
