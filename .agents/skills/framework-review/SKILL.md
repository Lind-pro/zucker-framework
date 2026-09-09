---
name: framework-review
description: "Review Zucker Framework contracts, adapters and consumer compatibility using concrete failure evidence."
---

# Framework review

Establish the diff scope, affected public API and consumers. Read schema and generated-type contracts when database fields are involved; do not force unrelated reviews through Prisma setup or a live server.

Prioritize API compatibility, dependency/bundling identity, lifecycle duplication, transaction boundaries, cancellation, retries, lease/fencing, idempotency and information exposure. Check the relevant package and consumer tests.

InMemoryAdapter tests cannot establish Prisma field compatibility or real database constraints. Choose a real adapter test when that is the risk. A schema validate or generate command alone does not prove concurrent/runtime correctness.

Report actionable defects with trigger, location, impact and evidence. Distinguish confirmed defects from verification gaps. Do not keep rerunning broad reviews just to obtain a new category of finding. Fix code only when requested or already in scope, and never post external review comments without authorization.

Use the [local workflow](../../../docs/runbooks/agent-development-workflow.md).
