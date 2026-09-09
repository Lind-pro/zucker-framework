# Local agent workflow

Scope and authorization are defined in [AGENTS.md](../../AGENTS.md). Inspect the current diff and the task's acceptance criteria before changing files. This workflow uses the repository's real tools; placeholders below must be replaced with actual files.

## Local feedback

| Task | Entry point |
| --- | --- |
| Instruction maintenance | `node scripts/check-agent-instructions.mjs` |
| Instruction checker changes | `node --test scripts/check-agent-instructions.test.mjs` |
| Library unit regression | `pnpm exec vitest run packages/<package>/src/<actual>.spec.ts` |
| Types/lint | Read the affected package script; check its public API and peer dependency contract |
| Template development | `pnpm dev:server`, `pnpm dev:admin`, or `pnpm dev:web` as relevant |
| Adapter work | Relevant PostgreSQL/Redis contract using explicit disposable test URLs |

Read package manifests to select affected consumers. test:durable-runtime builds @zucker-framework/task before tests; pack:release performs clean-tree artifact and fresh-consumer installs. These are stage-specific operations, not automatic steps after every edit.

For release preparation, read [package release](../package-release.md). Preserve immutable versions, checksums, registry scope, dry-run default and actual consumer compatibility. Do not turn a framework release into deployment/migration of every sibling app.

## Evidence and completion

Use independent read-only searches/checks concurrently when they do not share mutable resources. Use subagents only when allowed by the active session/instructions and a concrete independent task benefits; keep dependent edits sequential. No fixed delegation count, tool-call count or highest reasoning setting is required.

Stop expanding checks once the necessary evidence passes. Fix behavioral regressions with meaningful tests; do not add tests that restate prose or styling. For application changes, verify the affected development flow with synthetic data and report what was exercised. Missing runtime/browser evidence remains explicit; static success is not production health.

Preserve unrelated source and private configuration. Report files changed, test results, unresolved limits and migration/rollback implications. Proceed through build/commit/push/release stages only under existing explicit authorization. Do not bypass hooks or infer permission from a runbook command.

## Maintaining instructions

Keep enduring constraints in AGENTS, domain-specific decisions in .agents/skills, and longer material in relevant references. CLAUDE.md is a relative link to AGENTS.md. Canonical skill names/descriptions use single-line YAML values; descriptions use JSON-compatible quoting. Legacy skill paths link to the canonical sources.

Run the structural checker after edits; use the official skill-creator validator when available. It checks metadata syntax, not model quality. Use representative task outcomes to assess whether rules improve decisions. New sessions reload root instructions; preserve host/user model settings and avoid global configuration changes.
