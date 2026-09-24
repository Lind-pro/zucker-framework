# Application using Zucker Framework

## Before implementing a feature

Read the project README, package manifests and relevant existing callers/tests. Follow the actual directory and environment decisions recorded by this application. Reuse this reading within the task; wording/style changes do not need a new architecture exercise.

- Search the installed Framework package's public exports and types before creating a reusable mechanism. Check the fixed version; a source example or newer upstream API may not be in the installed artifact.
- Briefly identify the Framework reuse/extension point and the application-owned behavior. Reuse existing mechanisms directly through narrow configuration, data adapters or business callbacks. Do not copy Framework internals, create a parallel generic implementation, or add a forwarding layer only to rename an API.
- Product schemas, ownership policy, business workflows, prompts, plans/prices, recipients, UI and deployment configuration remain in this application. Framework must not depend on this application's code. Share domain contracts across application packages only when they have real consumers; keep single-feature types and helpers with their feature.
- A justified missing generic mechanism belongs in the owning Framework package. Preserve transactions, persistence, concurrency, idempotency and permissions. If access to that source or its release is unavailable, state the exact gap and finish independent work; do not hide it with unsafe casts, in-memory replacements or swallowed errors.

## Dependencies and runtime

- Normal builds use declared public Framework exports, fixed released versions and the project's lockfile. A sibling Framework checkout is optional development tooling, not a production dependency.
- Check peer/runtime identity and browser-versus-Node entrypoints. Do not bundle a second instance to conceal a dependency conflict or import native/server SDKs into client bundles.
- Register global infrastructure once at the composition root. Feature modules reuse configured providers. Preserve startup/shutdown for pools, timers and subscriptions.
- Choose this application's persistence and task topology explicitly. A demo memory adapter is not a durable store for accounts, orders or recoverable work.

## Local work and verification

Use only this project's documented development dependencies and synthetic data. Keep credentials out of tracked files and logs; do not copy another product's environment, data or secrets.

Make coherent changes and run the smallest relevant behavior checks and affected type/lint checks together. Verify browser flows when applicable. For replacements, test actual consumption and remove redundant implementations within scope. Report unavailable checks and release gaps accurately; a successful scaffold or build does not establish production readiness.

Preserve unrelated edits. Local implementation and relevant checks are the default scope. Commit, push, remote jobs, artifact publication, production builds and deployment require authorization for their stage; do not repeatedly request permission for already authorized work. Complete the reviewable local result before requesting a later delivery stage.
