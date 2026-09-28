# Framework Package Release

The release contract is an immutable, registry-hosted package. A local workspace,
symlink, `workspace:*` consumer dependency, or a tarball rebuilt under an existing
version is not a production release.

## Release versions

The package manifests and generated release manifest define the release set
and SDK peer ranges. Do not use version numbers from historical release inventories.
The first public release started all 51 libraries at `1.0.0` under
`@zucker-framework`; nine packages subsequently received `1.0.1`. The maintainer
selected `1.0.2` as the next shared version. All public `packages/*` libraries now
belong to one explicit Changesets `fixed` group, with no `linked` groups. A release
of any member versions and publishes the entire group together, including packages
whose implementation did not change. Add each new public package to this group;
private templates and the separate Python package are not members.

The maintainer explicitly limited the `1.0.3` compatibility release to `media`
and `logging`; those two manifests/changelogs are versioned directly for this
exception, and all other packages remain `1.0.2`. Do not run fixed-group versioning
for this scoped release. Its reviewed `publish.yml` call supplies `release_packages`
to reusable CI. CI still builds and verifies every package, but only selected
archives enter the sealed release manifest and publication bundle. Unselected
archives are verification inputs only and are removed before upload. The normal
fixed-group policy remains configured for later releases; clear or update this
explicit publication selection when preparing their reviewed version changes.

`logging@1.0.3` continues to depend on `core@1.0.2`. An application retaining
`admin@1.0.2` must resolve its exact `logging@1.0.2` reference to `1.0.3` as well
when adopting the fix, so Nest providers and controllers share one logging
instance. Consumers must verify that override instead of loading both versions.

Maintainer directive (2026-09-28): Framework releases increment the patch component
only. Record patch changesets for this release group, including necessary public
contract corrections. Remove superseded APIs/implementations and migrate all
consumers; do not introduce compatibility shims or parallel legacy implementations.
The patch number does not promise API compatibility: document changed contracts
explicitly and verify consumers against the actual immutable release.
Changesets keeps the fixed group on one shared patch version. The initial
alignment to `1.0.2` is an explicit maintainer-selected exception: it includes
breaking auth and payment changes. Read the [1.0.2 migration notes](package-release-1.0.2.md)
and package changelogs before upgrading; this release's patch number does not imply
backward compatibility.

Changesets prerelease mode has been exited; stable releases use `latest`.
Any later prerelease must use a separate tag, such as `rc`;
the publisher rejects prerelease versions under `latest`.
Check `packages/ai/package.json` before SDK compatibility work. Do not bundle a
second SDK merely because a consumer uses the reliability wrapper.

## Release prerequisites

1. The worktree is clean and the source commit is available from a protected remote.
2. The main-branch push pipeline in `publish.yml` has completed the reusable CI
   job for that exact commit: `CI / Build & Verify` (clean build, artifact
   verification, bundle upload). Skipped jobs, PR runs and other commits do not
   satisfy this requirement. The publisher validates job completion through
   GitHub’s API for the current attempt.
   Unit tests, lint and the PostgreSQL/Redis durable-runtime contracts are **not**
   part of the main-branch pipeline. They run locally in `.githooks/pre-push`
   before any push to `main` (build, legal/content checks, `pnpm test`, `pnpm lint`,
   `verify-nas-integration.mjs` against the designated NAS, and the same
   `verify-package-artifacts` check CI performs) and are repeated on pull requests
   by `pr-checks.yml`. The hook refuses the push when any check fails or when the
   NAS configuration file is missing; `ZUCKER_SKIP_PREPUSH=1` is permitted only
   for commits that change no package bytes, and must be noted in the commit.
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

The production release bundle is built and verified once by CI. Its `Build & Verify`
job retains the verified tarballs and consumer report under
`zucker-framework-ci-<run-id>-<attempt>`. The preparation and publication workflows
download these artifacts; neither rebuilds the framework or repacks the packages.
The existing CI-only PostgreSQL/Redis services remain isolated from application
databases and are used only by `pr-checks.yml`. Before a `main` push the same
contract suites run against the designated NAS through the pre-push hook
(`scripts/verify-nas-integration.mjs`, private `--env-file` under
`~/.config/zucker-framework/nas.env` or `ZUCKER_NAS_ENV_FILE`).

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

## Automatic publication

A push to `main` starts `Publish framework packages` (`publish.yml`). It calls
`ci.yml`, waits for both required jobs, downloads their exact verified artifact,
checks all tarballs and registry versions in a dry run, seals a receipt, and then
publishes through npm OIDC. Preparation and publication run in separate jobs and
never rebuild or repack. Only the publication job receives `id-token: write`.
PRs run CI without publishing. Source checkout, CI artifacts, receipt and GitHub
OIDC identity all identify the original push SHA, even when `main` advances.
Publication runs are serialized and an active upload is never automatically cancelled.

Before pushing a package change:

```bash
pnpm changeset
pnpm version-packages
pnpm install --lockfile-only --ignore-scripts
```

Select patch/minor/major according to the public contract, review the generated
versions and changelogs, and commit those files with the change. `pnpm changeset`
records release intent; `pnpm version-packages` applies it before CI builds the
artifacts. Unconsumed Changeset files alone do not change published versions.
The version command disables implicit dependency installation in its subprocesses
while manifests are being updated. Synchronize the lockfile explicitly afterward
with the command above; versioning does not need to reinstall application packages.
The fixed group automatically includes CLI and packages affected only by internal
dependency metadata. Keep internal declarations as `workspace:*`; pnpm converts
them to the group's exact version when packing. Regenerate the CLI's embedded
release catalog during its normal build. The dry-run checksum check catches stale
versions or artifacts before any package upload. A synchronized version does not
make npm's sequential package uploads atomic.

A push with no changed package bytes skips all uploads. Changing package bytes
without increasing that package's version fails preparation rather than overwriting
an existing version. There is no automatic version increase for a documentation
commit. New packages require an initial maintainer publication and their own npm
trusted publisher binding before they can join automatic publication.

The npm bindings for all existing packages use GitHub owner `Lind-pro`, repository
`zucker-framework`, workflow filename `publish.yml`, environment `npm-publish`,
and direct `npm publish` permission. GitHub's `npm-publish` environment allows only
the `main` branch and requires no manual reviewer. No npm token secret is used.
Changing the workflow filename, repository or environment requires updating npm's
external bindings as well. The repository remains private; npm does not generate
provenance for private source repositories.

For recovery, use **Re-run all jobs** on the original push run. This keeps source
identity fixed and produces matching CI and preparation artifacts for the new
attempt. Byte-identical versions already uploaded are skipped. Re-running only the
failed job cannot reuse a receipt from an older attempt. If build inputs have
changed despite the lockfile and produce different bytes, stop and prepare a new
version; never replace a published artifact. Artifact retention is 30 days.

The manual `release.yml` preparation and the `publish.yml` dispatch inputs remain
available for a reviewed bundle at the current `main` commit. The latter requires
the preparation run ID, manifest SHA-256 and matching distribution tag; it downloads
that approved bundle without running CI again. Older `ci.yml` main push evidence
remains supported for historical initial-release receipts. For a historical commit
that is no longer `main`, use the original push run's complete rerun instead of
changing checkout behind the workflow's OIDC identity.

The publisher verifies every checksum before upload. It queries all package versions
before publishing: an existing version with the same registry SHA-1 is skipped, while
an existing version with different bytes stops the release. Each uploaded package is
queried again to verify the registry checksum.
Registry checks use public version-specific metadata with unique read URLs to avoid
cached pre-publication 404 responses. When that route returns 404, the reader also
checks the same registry's package index for the exact version and checksum. A
dist-tag or upload acknowledgement alone never proves that the correct bytes exist.
Uploads remain sequential in dependency order; final version and tag verification
runs in batches of six after all uploads are acknowledged. This lets registry
propagation overlap with the remaining uploads. Missing metadata receives up to
five minutes of backoff per verification. Only metadata reads are retried; the
upload is never repeated automatically. An identity or checksum mismatch still
fails verification. Conflicts found during preflight stop the batch before any
upload. The verification report is written only when the entire batch passes.
Preparation dry runs likewise skip versions whose published bytes already match,
so a partially completed first release can be prepared again without trying to
simulate overwriting an existing version.
At the end of the batch it also checks the requested distribution tag for every
package, including versions skipped on retry, and writes `registry-verification.json`.
Tag checks use npm's dedicated `/-/package/<name>/dist-tags` endpoint, because the
aggregated package index can remain unavailable briefly after a first publication.
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

The workflows pin Node 24.14.1 and npm 11.19.1; OIDC requires npm >=11.5.1.
Use GitHub-hosted runners. npm's direct-publish permission is required: stage-only
permission would still require human 2FA approval and does not provide automatic
publication. See npm's [trusted publishing](https://docs.npmjs.com/trusted-publishers)
and [staged publishing](https://docs.npmjs.com/staged-publishing) documentation.

`--publish`, `--dry-run` and `--plan` must be used consistently; `--plan` cannot
upload packages. Dirty source is never accepted for upload. Keep registry tokens
out of tracked `.npmrc` files and command history.

## Consumer checks

The published 1.0.0 CRUD entry imports cache and event runtime tokens while marking
those peers optional; rule-engine likewise imports its optional event peer. Consumers remaining on 1.0.0 and using auth/CRUD should install
`@zucker-framework/cache@1.0.0` and `@zucker-framework/event@1.0.0` explicitly.
Rule-engine consumers must include event. A direct public-registry install with
these peers has passed ESM/CJS and CLI checks. Version 1.0.1 corrects the
required-peer declarations and refreshes the CLI scaffold catalog.

Artifact verification now checks static ESM imports against runtime dependency
declarations before installing the entire bundle, preventing unrelated installed
workspace packages from hiding this class of missing-dependency problem. Default
entries and their transitive local chunks must not require optional peers. Explicit
opt-in subpaths may load declared optional peers; shared chunks remain strict when
reachable from a default entry. Undeclared dependencies are rejected everywhere.
The independent consumer also imports the AI LangChain subpath in ESM and CommonJS
with its documented peers installed.

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

## Prepared CNIPA rendering release

The prepared rendering release selects only media 1.0.4. Logging remains 1.0.3 and all other npm packages retain their current versions. The new version and changelog are applied directly for this scoped exception; the fixed-group configuration remains unchanged. CI still validates the whole repository, and only media enters the publication bundle. The maintainer explicitly authorized this scoped 1.0.4 patch release for the CNIPA rollout. Python reaction changes are consumed as an immutable source archive in the CNIPA image, without a PyPI publication.

The scoped payment/credit release publishes `payment@1.0.3` and `credit@1.0.3` only;
media stays 1.0.4, logging 1.0.3 and every other package 1.0.2. Both manifests and
changelogs are versioned directly, the fixed-group configuration is unchanged, and
`publish.yml` supplies `release_packages` for these two packages. The removed legacy
payment exports had no implementation or consumer, which is why the maintainer
selected a patch instead of the fixed-group major. Both packages continue to depend
on `core@1.0.2` (credit also on `crud@1.0.2`).

## Scoped provider model discovery release

The maintainer authorized publication of the provider model discovery batch only:
`ai@1.0.3` and `admin@1.0.3`. Their manifests and changelogs are versioned directly
for this scoped exception; the fixed-group configuration remains unchanged. The
reviewed `publish.yml` selects these two packages. Admin's `workspace:*` AI
dependency packs as `1.0.3`, preserving a single AIModelCatalogService identity
with consumers. Other packages retain their current versions and are CI
verification inputs only. Consumers must adopt compatible AI and Admin versions
together; publication does not itself upgrade or deploy any consumer.

For this batch the maintainer explicitly selected a patch-only version increment, including the new experimental AI exports.

## Scoped conservative JSON recovery release

The maintainer requested the smallest version increment for the reviewed JSON
array recovery addition. Publish only `common@1.0.3`, applying its manifest and
changelog directly and consuming the pending changeset for this scoped patch
exception. The fixed-group configuration is unchanged; `publish.yml` selects
only Common while CI verifies all package artifacts. Existing parsing/repair
exports remain compatible, and schema validation and partial-result acceptance
remain consumer policy.

Previously published AI and Admin packages retain their exact Common dependency
versions. Consumers adopting `common@1.0.3` alongside those packages must align
their transitive Common resolution as well (for example, with a package-manager
override) and verify one Common/Nest provider and request-context instance. This
release does not upgrade or deploy those consumers. The release consumer smoke
checks exercise the new recovery API through both ESM and CommonJS exports.
