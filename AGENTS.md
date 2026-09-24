# Zucker Framework

## Working agreement

Complete the requested local work and relevant verification. Infer routine choices from the current code and the user's intent; ask only when missing information materially changes the outcome or required authorization is absent. Reuse authorization already granted within its scope. Preserve existing edits and generated deliverables; do not reset, stage, or overwrite unrelated work.

Default to local source/document changes and targeted checks. Production builds, commits, pushes, PR creation/merge, package/image publication, remote jobs and deployment require authorization for that stage; a passed local check grants no additional permission. Prepare a concrete reviewable result before asking for the next action. Never send messages to others without explicit authorization.

Read the target manifest/configuration, callers and tests instead of assuming versions or copying a tutorial. Search broadly when changing a cross-cutting contract, then change the relevant instances rather than every textual match. Validate untrusted input; retain useful redacted logs and comments explaining invariants. Avoid blanket bans on error handling, TODOs, or framework-specific styles.

Run the smallest relevant regression first. Broaden or repeat passed checks only for related changes, failures or unresolved risk. Do not reinstall unchanged dependencies, regenerate unchanged schemas, call paid providers or run full release gates during ordinary edits. Reassess after repeated failures without new evidence. Application behavior changes need local runtime/browser verification with synthetic data; documentation and instruction changes need structural checks.

## Instruction sources

This file is shared with CLAUDE.md. Repository skills are in .agents/skills; legacy paths are compatibility links. Load only the skill and references relevant to the task. User instructions take precedence over skill guidelines; skills do not authorize new scope or external actions. Explain any actual instruction conflict with its exact source.

Use the [local workflow](docs/runbooks/agent-development-workflow.md) for check selection. Report the result, evidence, unverified paths and migration/rollback impact concisely. Model/reasoning settings belong to the host and the user's selection, not a hard-coded repository default.

## Creating a new application

For a new product/application based on Framework, first read the [project bootstrap skill](.agents/skills/framework-project-bootstrap/SKILL.md) and [getting started](docs/getting-started.md). Create an independent consumer with its own `AGENTS.md` from the consumer template; do not copy this Framework-maintainer policy or another product's environment. The current released CLI scaffolds code but does not install the application's AI instructions. A request for guidance alone does not authorize creating a real project.

## Framework boundaries

Before adding a capability, public API, package or changing ownership, read [capability ownership](docs/architecture.md#新增能力的归属与接入) and the [Framework development skill](.agents/skills/framework-development/SKILL.md). Search existing exports and consumers before implementation, even when the request comes from a specific product. Reuse this reading within the task; ordinary wording/style fixes do not need an architecture exercise.

- Briefly identify the generic mechanism, the existing package/API evidence and the policy that remains in the consumer. Prefer extending an existing package. A new abstraction/package needs an actual contract and reuse or reliability/security reason; do not use `shared`/`utils` as a default owner.
- Framework must not import a consumer repository, its generated database client, domain schema, prompts, task names, prices or deployment settings. Expose neutral ports/configuration where consumer-specific data is needed. Templates remain examples of consumption, not a route for pulling product implementation into libraries.
- Preserve the consumer's persistence, transactions, ownership and failure guarantees. Separate browser-safe exports from Node/native SDK entrypoints, and retain a single compatible runtime/peer instance. Removing safeguards or copying a product implementation into a generic-looking file is not a completed extraction.
- Record the public export, affected consumers, replacement/removal and verification in the result. If integration needs an unreleased artifact, report that gap and complete authorized local work; do not create a second implementation or treat a source link as a published dependency. This check does not add routine approval steps or authorize publication.

- packages/* contains reusable libraries; templates/* contains consumers. Consumer code imports documented @zucker-framework/* exports, never packages/*/src internals. Match manifests, public exports and current tests before using signatures from documentation.
- Keep product names, schemas, prompts, tenant policies, provider credentials and environment-specific deployment choices out of library contracts. A second consumer or a concrete reliability/security requirement should justify extraction; shared-looking code alone is insufficient.
- Keep the dependency graph acyclic. @zucker-framework/core stays independent of NestJS; @zucker-framework/fe-types stays independent of backend packages. Preserve declared peer dependencies and avoid bundling duplicate NestJS or sibling framework runtimes.
- Configure NestJS global modules once at the consumer composition root. Feature modules reuse providers; pools, workers, timers and subscriptions need safe lifecycle behavior without duplicate initialization.
- Libraries receive configuration explicitly; do not read product process.env directly. Non-development JWT secrets must be explicit. Preserve redaction and distinguish best-effort audit logging from required durable/transactional audit storage supplied by the consumer.
- Test primitives in their package. InMemoryAdapter does not prove Prisma schemas, SQL constraints or real PostgreSQL/Redis behavior. Check actual schema/adapter contracts only when the change crosses those boundaries; do not force every review through database generation or full E2E.
- Consult [architecture](docs/architecture.md) for package boundaries, [durable runtime RFC](docs/durable-task-runtime-rfc.md) for leases/fencing and [package release](docs/package-release.md) before artifact/release changes. Package metadata and generated manifests govern current versions, not old prose inventories.
- Published versions are immutable. Verify clean source, versions, exported artifacts and consumer compatibility before an authorized publication; never overwrite published bytes or automatically migrate a sibling product.

API discovery and extension details live in the framework-development skill; evidence-oriented review is in framework-review. Do not load the full API catalogue for unrelated work.
