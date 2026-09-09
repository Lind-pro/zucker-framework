# Framework Package Release

The release contract is an immutable, registry-hosted package. A local workspace,
symlink, `workspace:*` consumer dependency, or a tarball rebuilt under an existing
version is not a production release.

## Release versions

The package manifests and generated release manifest define the release set
and SDK peer ranges. Do not use version numbers from historical release inventories.
The first public release starts all 51 libraries at `1.0.0` under
`@zucker-framework`, using the `latest` tag. Changesets prerelease mode has been
exited. This shared starting version does not link future releases: packages remain
independently versioned, with empty `fixed` and `linked` groups. After 1.0.0, use
patch versions for compatible fixes, minor versions for compatible new features,
and major versions for breaking public API changes. Review the generated changelogs
before upload. Any later prerelease must use a separate tag, such as `rc`;
the publisher rejects prerelease versions under `latest`.
Check `packages/ai/package.json` before SDK compatibility work. Do not bundle a
second SDK merely because a consumer uses the reliability wrapper.

## Release prerequisites

1. The worktree is clean and the source commit is available from a protected remote.
2. The latest main-branch push run of `ci.yml` has succeeded for that exact commit.
   Both `Build & Lint` and `Durable Runtime Contracts` must succeed; skipped jobs,
   PR runs, other workflows and other commits do not satisfy this requirement.
3. The npm account has permission to publish to the `zucker-framework` organization. The
   current target is public packages at `https://registry.npmjs.org/`, retaining
   `@zucker-framework/*`. Owning a GitHub namespace does not establish npm scope permission.
4. First publication uses the maintainer's npm login with 2FA enabled for writes.
   Later GitHub publication uses a configured npm trusted publisher (OIDC).
   Keep authentication out of source and chat messages.
5. Every changed package has a new version. Published versions are never replaced.
6. Apache-2.0 license text, framework attribution and bundled third-party notices
   are included and verified in every package.

The public npm scope is `@zucker-framework`, created by the maintainer. Earlier
review bundles used `@zucker`, which belongs to someone else and cannot be used
for this release. Rebuild and repack after the scope change; renaming a tarball
does not update its manifest, runtime imports or type declarations. Consumer
imports and dependency names must use the new scope together.

## CI-produced bundle and local review

The production release bundle is built and tested once by CI. Its `Build & Lint`
job retains the verified tarballs and consumer report under
`zucker-framework-ci-<run-id>-<attempt>`. The preparation and publication workflows
download these artifacts; neither rebuilds the framework or repacks the packages.
The existing CI-only PostgreSQL/Redis services remain isolated from application
databases. Local adapter checks continue to use the designated NAS.

The following commands remain useful for local review:

```bash
pnpm build:packages
pnpm legal:prepare
pnpm test
pnpm exec turbo run lint --filter='./packages/*'
pnpm pack:release
```

`pnpm pack:release` refuses a dirty worktree and never overwrites an existing bundle.
It packs all non-private `packages/*` libraries from their already-built output,
without rebuilding them a second time. It creates `artifacts/release` with tarballs
and `release-manifest.json`. The manifest records the source commit, source tree,
clean/dirty state, package versions, portable dependency declarations, and SHA-256
checksums. The command also installs
the tarballs in fresh npm and pnpm consumers and verifies ESM and CommonJS exports.
A local bundle alone is not an approved production bundle, even when its source
is clean: actual upload also requires the successful preparation run and its
approved manifest checksum.

For local review, `node scripts/verify-package-artifacts.mjs --output artifacts/review-<name>
--allow-dirty` may create a manifest marked `sourceDirty: true`. Such bundles are
unpublishable: the publisher accepts them only for an explicit local dry run with
`--allow-dirty`. A failed verification keeps the output for inspection; do not
confuse its existence with a completed release.

## License materials

The root `LICENSE` and `NOTICE` are authoritative. Every package declares
`Apache-2.0`; its `prepack` hook copies those files and generates
`THIRD_PARTY_NOTICES`. The generated copies are ignored by Git but explicitly
included in the package's `files` list.

The generator inspects current non-minified bundle inputs and copies complete
license texts, including copyright notices, for embedded dependencies. Currently
core embeds cuid2, noble/hashes and bignumber.js. Missing or unreviewed bundled
licenses stop preparation. If minification or the bundler output format changes,
update this detection before release; do not infer an empty license list from
missing input comments. Reference attributions use pinned revisions under `legal/`.

TypeScript adaptations retain hsweb-framework and jetlinks-community attribution
in NOTICE. Public package distribution does not make the source repository public
or require consumers to publish their application source.

## Source contents

Published packages must not contain source maps (including declaration maps),
inline `sourceMappingURL` data, or uncompiled TypeScript/JSX implementation files.
Keep `.d.ts`, `.d.mts`, and `.d.cts` files: consumers need these public type declarations.
Required JavaScript, SQL and Prisma assets remain readable in the package.
Local environment files, npm credentials/configuration and generated caches must
also stay out of the package. Missing declared entry files fail verification;
deleting old build outputs does not establish that a package is ready to publish.
Repository source, tests, CI configuration and agent instructions may be committed
to the private Git repository; that does not include them in npm packages. Each
package uses a `files` allowlist. Extra assets are listed by exact filename, and
package checks reject development documentation, agent rules, build configuration
and compiled test files even if they accidentally appear in build output. Keep the
published storage self-check command and the required SQL/Prisma/extension assets:
these are consumer-facing package functionality.

After `pnpm legal:prepare`, `pnpm verify:package-content` checks npm's file selection for every library without
running lifecycle scripts or building packages. Artifact verification and the
publisher also inspect actual tarballs and legal files. `pnpm release` uses the
same audited publisher instead of a separate direct Changesets upload path.
These checks do not replace credential review or consumer compatibility tests.

Turning off source maps does not remove old output. Rebuild clean artifacts during
an authorized release preparation; do not overwrite previously audited or published
versions. Old archives containing source maps are intentionally rejected.

## Publishing

1. Submit the reviewed source to `main` and wait for CI on that commit to finish.
   CI keeps the verified release artifact only for main-branch push runs.
2. Run `Prepare framework release` (`release.yml`) at that same commit, selecting
   the distribution tag (`latest` for 1.0.0). It checks CI through GitHub's API,
   downloads the exact CI artifact, performs npm dry runs and records a release
   receipt. Its summary contains the preparation run ID and manifest SHA-256.
3. Review that run's package list, versions and checksum. The successful run retains
   `zucker-framework-release-<run-id>-<attempt>`. Missing, expired or superseded
   workflow attempts fail verification rather than silently rebuilding artifacts.
   When rerunning CI, rerun all jobs so both required checks and the build artifact
   belong to the same attempt, then prepare the release again.
4. For the first release, download that approved artifact locally and publish using
   the maintainer's session and 2FA, as shown below. After trusted publishing is
   configured, use `Publish prepared framework release` (`publish.yml`), entering
   the preparation run ID, approved manifest SHA-256 and the same distribution tag.

Dispatch publication at a ref that still identifies the preparation commit. If
`main` has advanced, use a release tag pointing to the original commit. The workflow
does not check out a different commit behind GitHub's OIDC identity. An altered
manifest, wrong source commit, tag mismatch, failed CI job or stale receipt stops
publication before npm uploads. Workflow dispatch with the reviewed run ID and
checksum is the explicit upload decision; additional GitHub environment reviewer
rules can be configured separately if a second approver is desired.

The publisher verifies every checksum before upload. It queries all package versions
before publishing: an existing version with the same registry SHA-1 is skipped, while
an existing version with different bytes stops the release. Each uploaded package is
queried again to verify the registry checksum.
Registry checks use public version-specific metadata with unique read URLs to avoid
cached pre-publication 404 responses. A new version that is temporarily absent is
retried within a bounded window; an actual identity or checksum mismatch still
stops immediately. Read-only preflight requests run in small parallel batches;
uploads remain sequential in dependency order.
At the end of the batch it also checks the requested distribution tag for every
package, including versions skipped on retry, and writes `registry-verification.json`.
It fails on a tag mismatch instead of silently moving a tag with different credentials.

Uploads follow the dependency graph from the actual packed manifests, including
peer dependencies. CLI waits for the package versions in its scaffold catalog
without installing them all as its own runtime dependencies. Cycles or duplicate
package identities fail before upload. npm does not provide atomic multi-package
publication: retry the same approved bundle after a partial failure; never rebuild
new bytes under its already published versions.

For the first release, keep a clean checkout of the preparation commit, authenticate
`gh` for read access to this repository, and use the run ID and checksum from the
preparation summary. The placeholders below must be replaced with those exact values:

```bash
node scripts/prepare-release.mjs download-prepared \
  --run <preparation-run-id> \
  --manifest-sha256 <approved-sha256> \
  --output artifacts/approved-release

pnpm publish:packages -- \
  --bundle artifacts/approved-release \
  --publish --auth session \
  --manifest-sha256 <approved-sha256> \
  --tag latest
```

Without `--publish`, the publisher still defaults to an npm dry run. To inspect
the actual upload order and archive checksums without npm calls:

```bash
node scripts/publish-packages.mjs --bundle artifacts/approved-release --plan
```

Local session publication checks `npm whoami` without reading stored credentials.
Token authentication remains available explicitly for existing integrations, but
the new publication workflow uses OIDC and contains no npm token secret. OIDC
authentication occurs during `npm publish`, so `npm whoami` is deliberately skipped
for that mode. Public registry version/checksum reads do not require OIDC. The job
must run on GitHub-hosted runners at the exact release SHA with `id-token: write`.

After the packages exist, configure each package's npm trusted publisher with
GitHub owner `Lind-pro`, repository `zucker-framework`, workflow `publish.yml`, and
permission for direct `npm publish`. Newly configured trusted publishers may
default to stage-only access; that is not sufficient for this workflow. These npm
settings are external prerequisites, not changes made by committing workflow files.
The workflows pin Node 24.14.1 and publishing npm 11.19.1; OIDC itself requires npm
>=11.5.1. Source repositories may remain private; npm provenance is not generated
for private repositories.

Optional future staged publishing requires npm >=11.15.0, existing package records
and maintainer 2FA approval. It cannot bootstrap a brand-new package and is not used
by this direct-publication workflow. See npm's [trusted publishing](https://docs.npmjs.com/trusted-publishers)
and [staged publishing](https://docs.npmjs.com/staged-publishing) documentation.

`--publish`, `--dry-run` and `--plan` must be used consistently; `--plan` cannot
upload packages. Dirty source is never accepted for upload. Keep registry tokens
out of tracked `.npmrc` files and command history.

## Consumer checks

Artifact verification installs tarballs in fresh npm and pnpm consumers, verifies
portable dependency declarations, checks peers and exercises ESM/CommonJS exports.
It also checks 49 library declaration surfaces with strict NodeNext ESM/CJS
settings, renders a synthetic frontend form, and compiles/starts the CLI-generated
server outside the framework workspace. Frontend callers use strict types with
`skipLibCheck: true`, matching the frontend template: Ant Design's own dependency
declarations currently have strict-library-check issues with React 19. Both Bundler
and NodeNext frontend callers must retain a concrete, non-any form rule type.
It uses separate temporary npm configuration, so an expired maintainer token does
not contaminate public dependency installation. This local check does not prove
that the publishing account controls the npm scope.

The CLI includes a standalone server scaffold using versions captured in its
release catalog, a standalone TypeScript configuration and a newly generated local
JWT secret. The full admin/web templates require a framework checkout. Generated
projects and framework packages have separate build and deployment lifecycles.
The CLI requires Node.js 22.12 or later, consistent with Commander 15. The repository
toolchain requires Node.js 22.22 or later; this does not replace individual library
runtime contracts.

## NAS integration verification

Local integration validation must use the user's designated NAS
services and approved test database/schema and Redis namespace. Do not create
replacement local services or point destructive test fixtures at an application
database. A skipped integration test is not evidence for NAS compatibility.
Shared Redis validation uses unique queue names, reconnects only the test client,
and removes only that test queue's keys. Never use instance-wide pause/flush commands
for these checks. Temporary PostgreSQL databases must be explicitly designated for
tests and cleaned up without changing application databases.

After building the packages, run the following with an existing private NAS
configuration file once temporary test database creation is authorized:

```bash
node scripts/verify-nas-integration.mjs --env-file /absolute/path/to/private-nas.env
```

The runner reads only PostgreSQL and Redis connection settings from that file:
`NAS_TEST_ADMIN_DATABASE_URL` / `NAS_TEST_REDIS_URL`, falling back to
`DATABASE_URL` / `REDIS_URL`. It does not edit the file or pass its unrelated
settings to the tests. Without `--env-file`, it reads the same settings from the
current environment. Keep actual NAS addresses and credentials in private config.

The PostgreSQL account must be able to connect to the `postgres` maintenance
database and create/drop its own temporary databases. The runner creates a unique
`zucker_release_*` database for the four PostgreSQL/Redis integration test files,
then drops only that database. Redis needs no database creation: the runner retains
the configured logical DB, uses a unique `zucker-release-*` key prefix, and removes
only keys with that prefix. It does not start services or change application data.

Review `artifacts/nas-integration-verification.json` and the accompanying redacted
`.log`. Success requires `testsPassed: true`, `databaseRemoved: true` and
`redisKeysRemaining: 0`. Test or cleanup failure produces a nonzero exit status;
an interrupted process or lost connection still requires checking cleanup using
the generated names in the report. These local reports do not replace CI evidence
for the source commit selected for publication.

## Consumer adoption

After an authorized registry release, each consumer separately selects the exact
versions recorded in `release-manifest.json`, verifies its lockfile and public API
compatibility, and follows its own deployment/credential contract. A framework
release does not authorize editing, rebuilding or deploying every consumer.

Run the relevant package, real adapter and product integration checks before
removing the consumer's previous implementation. Executor topology, feature flags,
schema migrations and canary policy belong to the consumer; do not prescribe a
standalone Worker or a specific product's environment from this framework guide.

Rollback changes the exact package version and rebuilds the image. It never overwrites
an already published package and never deletes durable task records.
