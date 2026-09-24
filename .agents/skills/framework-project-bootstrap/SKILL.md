---
name: framework-project-bootstrap
description: "Initialize a new standalone application using Zucker Framework, with application-owned AI instructions, published dependencies and a verified minimal flow. Use for creating a new consumer project, not for adding a feature to an existing project or maintaining Framework packages."
---

# Bootstrap a Framework application

Read [getting started](../../../docs/getting-started.md) and [capability ownership](../../../docs/architecture.md#新增能力的归属与接入) before creating files. Use the [package map](../framework-development/references/package-map.md) to locate capabilities, then check actual public exports, peer dependencies and published versions.

## Establish the application boundary

- Confirm the target directory, product purpose and required surfaces from the request. Choose the smallest useful shape: a standalone server, a frontend, or an application workspace only when multiple apps are needed. Ask only for missing information that changes the result; do not overwrite an existing project or infer a deployment target.
- Create the application outside the Framework checkout. Product modules, schemas, prompts, permissions, pricing and environment choices belong to the new application. Do not copy another business application's code, databases, credentials or AI instructions as a shortcut.
- Briefly identify which Framework APIs will be used and which product rules stay local. Existing generic mechanisms are reused; justified missing mechanisms are changes to their owning Framework package, not new application `shared` implementations.

## Initialize against real artifacts

- Select an explicit released CLI/package version. The installed CLI's standalone server scaffold is distinct from the full repository templates; follow the guide's actual support limits. Do not claim that CLI-generated files include AI instructions unless verified.
- Use fixed published Framework dependencies and a project lockfile. Do not make the application require a sibling checkout or copy `workspace:*` and source aliases into its normal build. Source development, if requested, must have an explicit separate mode.
- Read copied configurations for repository-relative paths and required assets. Pin the project's package manager and compatible runtime from actual manifests. Install only needed capabilities and verify peers/runtime identity; do not blindly install every package or run an unversioned `add` command.

## Give the new project its own instructions

Before adding business features, adapt the [consumer AGENTS template](../../../docs/templates/consumer-AGENTS.md) into the new project's `AGENTS.md`. Create a relative `CLAUDE.md` link to it where appropriate; preserve any existing user instructions. The application's rules must work without the Framework source directory.

Write a short project README with the actual purpose, existing directory responsibilities, selected Framework packages, runnable commands, local dependency requirements and verification status. For a small application this is sufficient; do not create empty architecture layers, unused skills or a large documentation tree. Do not copy Framework's maintainer AGENTS.md into a consumer.

## Verify the first flow

- Register infrastructure once and bind persistent data through the supported adapters/ports. A scaffold's InMemoryAdapter is a disposable demonstration, not evidence for persistent accounts, billing, tasks or production readiness.
- Use project-specific development dependencies and synthetic input. If their configuration is missing, prepare independent files and record the exact gap; never borrow an existing product's live environment or silently switch to a remote database.
- Complete the smallest requested vertical flow and verify its actual request, response and data behavior, plus affected type/lint checks. Frontends need browser verification, including their API base path and auth behavior when used. A folder of generated files or a static `doctor` result is not a working application.
- Report the project path, chosen packages/versions, instruction entrypoint, checks and remaining gaps. Repository creation does not authorize commit, push, package publication, production build or deployment beyond the user's stated scope.
