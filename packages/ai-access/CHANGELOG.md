# @zucker-framework/ai-access

## 1.0.5

## 1.0.2

### Patch Changes

- c0de08f: Add explicit LangChain chat/embedding construction, text stream collection, structured execution and strict schema postprocessing through public AI entry points. Keep provider routing, chat retry count, recovery prompts/budgets and optional array-root mapping caller-controlled. SDKs remain lazy; idle/cancel failures bypass parser recovery.

  Add a lazy coalesced AI access client session with one provider attempt per explicit invocation and awaited outcome observers. Failed initialization can recover on a later request without automatically retrying provider work.

- c0de08f: Add paired Unix socket host/client transport for restricted Codex CLI inference, with explicit host configuration, allowed model arguments, schema transfer, separated stdout/stderr/exit status, cancellation and per-request scratch cleanup. Product paths, environment variables and service startup remain in the consumer.
- Align all public Framework packages to the maintainer-selected 1.0.2 release and keep subsequent releases synchronized through a Changesets fixed group. Package dependencies and the CLI scaffold catalog follow the same version.

  This release consolidates the pending API migrations, including breaking auth and payment persistence contracts. Review docs/package-release-1.0.2.md before upgrading from 1.0.0 or 1.0.1.

## 1.0.0

### Major Changes

- First stable public release under the @zucker-framework organization. Publish compiled JavaScript, public type declarations, required runtime assets and Apache-2.0 license materials without source maps.

### Minor Changes

- Add provider-neutral AI access contracts, a provider registry, credential profiles, and PostgreSQL/in-memory profile stores.
- Add a trusted-automation Codex subscription provider with an official `codex exec` driver, ephemeral structured runs, least-privilege permission profiles, isolated child environments, cancellation and timeout handling. Keep the direct ChatGPT Responses transport as an explicitly experimental compatibility path.
- Add generic AI provider discovery, PostgreSQL Profile initialization, login, status, file import, and smoke commands without provider-specific command branching.

### Patch Changes

- Add Apache-2.0 license files, framework attribution, bundled third-party notices,
  and public npm publishing metadata to every library. Validate these materials
  in package contents before upload and declare required and optional runtime dependencies.
