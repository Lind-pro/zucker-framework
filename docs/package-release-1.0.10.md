# SaaS infrastructure 1.0.10 release preparation

Status: release authorized and locally verified, 2026-10-25. This document does not establish
registry publication, a successful publication workflow, real-provider acceptance,
or a production deployment. Follow [the package release contract](package-release.md)
for the immutable source, CI bundle and publication evidence.

## Source and version scope

The preparation starts from protected-remote `main` commit
`dfacad3f860fbd53115edc0d3eb63fdc2c5944b1`, then applies the reviewed I0–I6 SaaS
infrastructure changes. All 52 public npm packages, including the new `fe-site`,
are aligned to `1.0.10` in the Changesets fixed group. Private templates retain
their own versions. Internal `workspace:*` declarations become exact shared
versions in packed artifacts; consumers must check the complete dependency graph.

The public registry already contains `ai`, `crud` and `logging` at `1.0.9`, while
the other existing packages were at `1.0.8` when preparation began. Their published
changes, changelogs and release checks are retained. This includes OpenAI source
image editing and single-attempt usage contracts, the LangChain configured-Runnable
stream contract, CRUD query totals and active-record isolation, and logging HTTP
completion observations and persistence policies. `1.0.9` is not available for a
new shared release with different bytes.

Independent pending Gemini image-provider changes are excluded. In particular,
this release does not add Gemini single-attempt retry control, the new detailed
image-usage projection or its associated image-provider tests. Native Gemini text
connection configuration in the SaaS Server template is a separate, included
capability; it does not imply image generation or image editing support.

The maintainer's patch-only version policy remains in effect. The patch number
does not guarantee API compatibility: inspect the contracts below and the package
changelogs before upgrading an existing application.

## Included infrastructure and adoption changes

| Area | Prepared change | Consumer adoption requirement |
| --- | --- | --- |
| CLI and templates | Bundled `server-full`, Admin and Web assets, release catalog, consumer instructions and standalone commands | Generate outside the Framework checkout; supply the application's database, origins and enabled providers. The minimal `server` scaffold remains an in-memory example. |
| Accounts | Durable session refresh adapter, one-time tickets, Google token verification, OAuth proofs and owner-scoped API Key renaming | Bind persistence and identity policies explicitly. The generic third-party binding endpoint requires verified proof; browser-supplied profile data is no longer sufficient. |
| Default administration | Action-level permissions, atomic role and user-role replacement, metadata-only permission edits, working dictionary/form persistence | Assign the applicable read/write actions to delegated administrators. `roles:authorize` and `users:authorize` are separate operations; ordinary metadata edits preserve grants. |
| Payment and entitlements | Hosted checkout, Stripe/PayPal/Creem subscription evidence, refunds, credit-lot holds and expiry | Bind durable orders, journals and ledger transactions. Keep unknown provider outcomes pending reconciliation. PayPal payment receipts do not establish service periods; entitlement policy remains application-owned. |
| Tasks and notifications | Durable host composition, interruption/draining, PostgreSQL notification repository and lease-aware recovery | Configure one host, the persistent schema and explicit delivery providers. Account verification mail retains its immediate-send contract; it is not automatically migrated to the durable worker. |
| Files | Private asset metadata, verified upload/read, logical deletion and explicit recovery | Bind ownership, uniqueness and state transitions. The full template's 10 MiB limit, explicit recovery and buffered transfer behavior do not promise large-file streaming or automatic cleanup. |
| Configuration | Protected history/events, explicit encryption and 16 encrypted connection profiles in the full template | Provide an independent settings-encryption key. Missing encryption or decryption failure rejects protected operations. Applying connection changes requires the documented restart; existing history is not automatically rewritten. |
| Public site | `fe-site` content/connection contracts, CMS/blog/docs, themes/blocks, locale/SEO and optional analytics/advertising/referral/support connections | Supply branding, content, product offers and provider accounts. Enable only required connections; mounting a script is not evidence of a real report or successful attribution. |
| Module and form compatibility | Explicit ESM/CJS package-root exports, shared EventEmitter2 injection and optional localized `DynamicForm.messages` | Resolve one compatible sibling/Nest instance. Keep existing field labels and validators under the consumer's control; do not mix duplicate import/require module instances. |

Default HTTP exception logs no longer include unknown raw messages or stacks;
applications needing diagnostics must provide the explicit, redacted error hook.
The logging privacy ceilings can disable parameter/result capture even when a
controller opts in. These changes supplement the preserved `logging@1.0.9`
observation and sampling contracts.

The Redis factory types in cache and rate-limiter now use ioredis's named `Redis`
export. This fixes strict NodeNext ESM declaration consumers without changing the
runtime client loading or relaxing the consumer's TypeScript checks.

Existing applications should review the Admin request DTOs and response envelopes
against their installed versions. The template's menus and business defaults are
examples of consumption; they are not a database migration or authorization policy
for CNIPA or another existing product.

## New package publication prerequisite

`@zucker-framework/fe-site` is a new public package. Its public registry lookup
returned 404 during preparation. Before completing the shared publication, the
maintainer must perform the initial publication through the documented npm/2FA
flow and establish this package's trusted-publisher binding for the existing
GitHub repository, workflow and environment. Existing packages' bindings do not
automatically grant publication rights to the new package.

Use the exact verified archive for that first upload and preserve its checksum.
The publisher may skip an already uploaded version only when its bytes match;
do not create another archive under the same version. Sequential uploads are not
atomic, so consumers must wait for the complete release and distribution-tag
verification before adoption.

## Evidence and remaining acceptance

The earlier `20261024-infra-final-02` checkpoint validated a 35-package dependency
closure, three generated consumers, 13 migrations, 98 persistent contract cases
and 10 browser flows. Its artifacts are explicitly local-only, with
`sourceDirty: true` and `publishable: false`; most carry the already published
version `1.0.8`. They must not be uploaded as this release or relabeled `1.0.10`.

Reuse unchanged behavioral checks where their inputs remain applicable. The new
52-package release still needs exact-source artifact verification, the required
clean CI-produced bundle and the normal publication receipts. The current
preparation record does not replace those results. Preserve the newer baseline's
CRUD consumer/PostgreSQL checks and matched Nest common/core/platform-express
versions when verifying generated consumers.

Provider tests so far use synthetic responses or isolated local dependencies.
Real payment test accounts, OAuth applications/callbacks, cloud storage, email,
analytics and other provider accounts need their own authorized acceptance. A
published package alone does not prove any provider credentials or production
configuration work.

CNIPA adoption is separate: update exact dependencies and its lockfile after the
complete package batch is available, verify without sibling source links, and test
the affected application contracts. CNIPA's local Admin navigation improvements
do not demonstrate that its backend has adopted these new Framework capabilities.
Production deployment and actual paid calls remain separate actions.

### Local preparation verification, 2026-10-25

- All 52 package builds passed. The second review bundle passed archive content,
  dependency, fresh npm/pnpm installation, 50 strict declaration surfaces, 42 runtime
  imports, frontend SSR and installed-CLI generated server checks. Publication
  ordering and the registry-aware npm dry run passed; no packages were uploaded.
- Unit tests: 3,972 passed. The seven initially skipped PostgreSQL/Redis cases were
  then run against isolated resources in the authorized development dependencies:
  all seven passed, with the temporary schemas and Redis keys removed.
- Lint completed with zero errors and 490 warnings. The CLI instruction/template
  and package-content tooling checks passed all 33 cases.
- An independent copy of CNIPA's current Server source compiled against the
  candidate package closure and passed 37 focused tests. No live CNIPA dependency,
  schema, running service or existing account was changed. Its existing
  `skipLibCheck: true` setting was retained; the stricter library declaration checks
  above are recorded separately.
- After explicit authorization for the release and the disposable NAS database,
  the unmodified NAS release runner also passed all seven PostgreSQL/Redis cases
  and the CRUD PostgreSQL/Prisma contract. The temporary database was dropped and
  the Redis prefix contained zero remaining keys. CI must still verify its clean
  checkout and produce the publication bundle for the exact source commit.
- The local review archives were built before committing and their manifest records
  `sourceDirty: true`. They are review evidence, not the clean CI-produced production
  release bundle. First publication/trusted publishing for the new `fe-site`
  package remains to be completed under the release contract.
- After the user supplied the recipient, Resend accepted two calls with one
  idempotency key and returned one message identity. Gmail confirmed exactly one
  matching INBOX message. This verifies the candidate notification provider and
  delivery to that recipient, not every account email workflow.
- The explicitly authorized R2 test bucket rejected the first upload with
  AccessDenied/HTTP 403. Cleanup and existence checks were also denied. No successful
  upload was recorded, and cleanup cannot be verified with the current credentials.
  The canary was stopped without retrying the upload or changing bucket permissions;
  usable development access is required before repeating this channel check.

## Migration and rollback

New `server-full` consumers own their schema and the included migration chain.
Do not replay that template chain into an existing application's database without
mapping its schema and policies. Preserve independently generated JWT and
settings-encryption keys; do not replace an existing application's keys during
scaffold or dependency upgrades.

For an existing consumer, record the previous source, exact dependency versions,
lockfile, configuration and applicable migration state together. Rollback restores
that compatible combination; downgrading only npm versions can leave calls to new
APIs or incompatible data expectations. Never overwrite published package bytes
or treat a local configuration upgrade/rollback test as a universal database
rollback guarantee.
