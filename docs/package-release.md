# Framework Package Release

The production contract is an immutable, registry-hosted RC. A local workspace,
symlink, `workspace:*` consumer dependency, or a tarball rebuilt under an existing
version is not a production release.

## Current RC set

- `@zucker/core@0.1.0-rc.3`
- `@zucker/task@0.1.0-rc.12`
- `@zucker/queue@0.1.0-rc.6`
- `@zucker/ai@0.1.0-rc.4`
- `@zucker/logging@0.1.0-rc.2`
- `@zucker/monitoring@0.1.0-rc.4`
- `@zucker/storage@0.1.0-rc.2`
- `@zucker/credit@0.1.0-rc.4`
- `@zucker/feature-flags@0.1.0-rc.2`
- `@zucker/notification@0.1.0-rc.4`

`@zucker/ai` treats the OpenAI SDK as an optional peer (`>=4.80.0 <7`). Consumers
that only use the reliability wrapper do not receive a second SDK version.

## Release prerequisites

1. The worktree is clean and the source commit is available from a protected remote.
2. CI build, unit tests, lint, durable PostgreSQL/Redis contracts, and package artifact
   verification have passed for that commit.
3. The selected private npm-compatible registry supports the existing `@zucker`
   scope. Do not silently rename packages to match a registry owner.
4. The repository secret `PACKAGE_REGISTRY_TOKEN` can publish restricted packages to
   the selected registry.
5. Every changed package has a new RC version. Published versions are never replaced.

## Audited bundle

```bash
pnpm build
pnpm test
pnpm lint
pnpm pack:rc
```

`pnpm pack:rc` refuses a dirty worktree. It creates `artifacts/rc` with ten tarballs
and `release-manifest.json`. The manifest records the source commit, source tree,
clean/dirty state, package versions, portable dependency declarations, and SHA-256
checksums. The command also installs
the tarballs in fresh npm and pnpm consumers and verifies ESM and CommonJS exports.

For local script development only, `--allow-dirty` may create a manifest marked
`sourceDirty: true`. The publisher refuses that manifest.

## Publishing

Use the manual `Release framework RC packages` GitHub Actions workflow. Its default
is a dry run. The operator must enter the registry URL and distribution tag; a real
publish additionally requires `PACKAGE_REGISTRY_TOKEN`.

The publisher verifies every checksum before upload. It queries all package versions
before publishing: an existing version with the same registry SHA-1 is skipped, while
an existing version with different bytes stops the release. Each uploaded package is
queried again to verify the registry checksum.

The equivalent local command is:

```bash
PACKAGE_REGISTRY_URL=https://registry.example.com \
NODE_AUTH_TOKEN=... \
pnpm publish:rc -- --tag=rc
```

Do not put registry tokens in a tracked `.npmrc` or command history.

## CNIPA adoption

After the registry release succeeds, CNIPA must replace `file:../../vendor/...tgz`
with the exact versions recorded in `release-manifest.json`, configure the `@zucker`
registry only in CI and Docker secret mounts, regenerate the frozen lockfile, and
rerun package contracts, server tests, image build, migration replay, and Worker
canary. Feature flags remain off until each business task kind completes its internal
canary.

Rollback changes the exact package version and rebuilds the image. It never overwrites
an already published package and never deletes durable task records.
