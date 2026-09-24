---
name: framework-development
description: "Develop Zucker Framework packages or their consumer integration while preserving product-neutral public contracts."
---

# Framework development

When the task is to create a new consumer project, use [project bootstrap](../framework-project-bootstrap/SKILL.md) first. This skill covers package changes and integration after the application boundary is established.

Before adding a capability or changing ownership, read [capability ownership](../../../docs/architecture.md#新增能力的归属与接入). Then read the target package manifest, exports, tests and callers. Use the [package map](references/package-map.md) only to locate relevant packages; actual exports/types govern API signatures and must be checked against the consumer's installed version.

Identify the consumer need and failure contract before adding an abstraction. Keep product schemas, prompts, pricing and environment policy out of the library. Reuse existing primitives when they fit; do not require a new package or a fixed number of test cases for every contribution.

Briefly identify the mechanism's existing owner, API evidence and remaining consumer policy before implementation. Extend the owning package instead of creating a parallel helper or importing consumer implementation. When persistence is involved, use neutral ports bound by the consumer and preserve atomicity/ownership/failure guarantees. Browser exports must not pull in Node/native dependencies. Complete the intended replacement and remove redundant implementations within scope; explain any remaining release/integration gap without hiding it behind copies or unsafe casts.

Preserve acyclic dependencies, configured module lifecycles, explicit configuration injection and peer dependency identity. Test public behavior and failure semantics in the package. For schema/adapter work add the appropriate real dependency contract; an in-memory substitute does not prove SQL or provider behavior.

For a new public API, update exports and the focused package documentation. Before release, follow [package release](../../../docs/package-release.md) and verify the actual versioned artifact in a consumer. Integrate and verify a replacement before removing a consumer's old implementation. Sibling product changes and publication remain separately scoped actions.

Use the [local workflow](../../../docs/runbooks/agent-development-workflow.md) for check selection.
