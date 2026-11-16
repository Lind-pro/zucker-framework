# Launch acceptance from packed artefacts

`pnpm acceptance:launch` (`scripts/acceptance/launch-ready.mjs`) proves the "ready to launch" definition
(the numbered steps below) on a project generated from **packed tarballs**, the way a consumer would get it,
with fakes only. It is a verification run, not a release: publication needs separate authorisation.

```bash
# Everything (pack, generate, install, host tier, Docker tier, teardown). Docker must be callable as `docker`.
pnpm acceptance:launch --work /tmp/zf-accept-1
# Only some phases (reuse the work directory of an earlier run):
pnpm acceptance:launch --work /tmp/zf-accept-1 --phases create,install,host --tier host
pnpm acceptance:launch --work /tmp/zf-accept-1 --phases compose --tier compose --keep   # leave the stack up
pnpm acceptance:launch --work /tmp/zf-accept-1 --phases teardown                          # remove it later
```

Output: `<work>/report.json` (one entry per step: `id`, `title`, `status` pass/fail/skip, `evidence`),
`<work>/logs/*.log` (command output; these can contain generated configuration, keep them private) and
`<work>/logs/registry-requests.jsonl` (every request the local registry received, with its outcome).

## Phases

| Phase | What it does |
|---|---|
| `pack` | `pnpm build:packages`, then `pnpm pack` for every public package into `<work>/pack/tarballs` and `manifest.json` (`release: false`; a dirty tree is allowed). The CLI rebuilds its template bundle whenever `templates/**` or `docs/templates/**` change. |
| `create` | Starts `scripts/acceptance/file-registry.mjs` on 127.0.0.1, warms every packed Framework package with `pnpm store add`, then runs `pnpm dlx @zucker-framework/cli@<version> create my-saas` with `offline=true`. The scope points at this registry, which serves only the packed versions. Then checks step 1. |
| `install` | `pnpm store add` of every framework package (puts their metadata in the local cache), then `pnpm install --offline`. The lockfile must carry exactly the packed tarballs' integrity for every framework package and no registry URL. |
| `host` | Throwaway PostgreSQL container, `pnpm db:migrate`, `pnpm setup:admin`, `content:check`, `pnpm build`, `pnpm lint`. |
| `compose` | Rewrites the generated `.env` to free ports, builds the images with `scripts/acceptance/compose.acceptance.yml` (host build network, `NPM_REGISTRY` = the local registry in proxy mode), `docker compose up --wait`, administrator setup through the `migrate` image, then the checks of `scripts/acceptance/checks.mjs`. |
| `teardown` | `docker compose -p zf-accept-<id> down -v --rmi local`: this project's containers, volumes and built images only. Runs automatically unless `--keep`. |

## Registry modes and fallbacks

- **Offline CLI execution for `create`:** before `dlx`, `pnpm store add` fetches the explicit Framework
  package list from the loopback registry to populate its fresh metadata cache and tarball store. It
  does not resolve or install their dependencies. The CLI then runs offline; third-party packages
  must already be in this machine's pnpm store and metadata cache. Missing third-party cache entries
  stop this phase without falling back to the public registry.
- **Install fallback:** if `pnpm install --offline` lacks metadata for a third-party range, the run retries
  with `--prefer-offline` and records it in the `install` step (`method`). Framework packages still come only
  from the local registry (the scoped registry never forwards `@zucker-framework/*`), so the result is the
  same artefact set; third-party packages then come from the public registry (authorised network, D18).
- **Proxy mode for image builds:** inside `docker build` the pnpm store is empty, so the registry forwards
  non-framework metadata and tarball requests to `https://registry.npmjs.org/`. Base images
  (`node:24-alpine`, `postgres:17-alpine`, `redis:7-alpine`, `chrislusf/seaweedfs`, `axllent/mailpit`,
  `nginxinc/nginx-unprivileged`) are pulled once. Without network authorisation, run `--tier host` only.
- The generated Dockerfiles take `NPM_REGISTRY` (default `https://registry.npmjs.org/`); the compose file
  passes `${NPM_REGISTRY}` through. The same argument serves private mirrors in production builds.

## Passes

The fake payment provider (`BILLING_TEST_FAKE_PROVIDER`) and the fake AI providers (`AI_TEST_FAKE_PROVIDERS`)
refuse `NODE_ENV=production`. Pass 1 therefore runs the stack exactly as generated (production, no fakes)
for steps 2, 3, 6, 7, 8 and 9. Pass 2 recreates only the server container with `NODE_ENV=test` and both
fakes (`ACCEPT_NODE_ENV`, `ACCEPT_TEST_FAKES` in the override) for steps 4 and 5.

## Steps (PLAN §2)

1. Workspace layout, one root `.env` (0600, distinct generated secrets, never printed), `AGENTS.md`, skills
   with `.claude/skills` links, no `workspace:`/`file:`/`link:` in any manifest.
2. Images build; `docker compose up` brings PostgreSQL, Redis, S3 storage (SeaweedFS), Mailpit, the one-shot
   `migrate`, server, web and admin up healthy; administrator setup seeds starter content, two example plans
   and one credit pack.
3. Without provider credentials: CMS home, pricing ("not purchasable"), blog, docs, privacy, terms,
   changelog; sign-up, verification and password reset through Mailpit; console; admin login.
4. Fake provider: pack with a promo code, plan; return and webhook; credits granted once after a webhook
   replay; header balance; payment hot-apply (order before a payment profile save settles, new order after).
5. AI with fakes: `e2e/stack/ai-stack.spec.ts` (image submit → complete → download, streaming chat, stop
   settlement) plus a price change applying to the next task and cross-user isolation.
6. Every admin menu page loads as the administrator without failed API calls.
7. SEO: canonical, hreflang, OG/Twitter, OG image, sitemap (static and CMS entries), robots; zh routes.
8. Hot apply without restart: `web-analytics` script appears; the account mail profile moves the next mail
   to a second catcher.
9. Security spot checks (403 for a non-administrator write, forged callbacks inert, 429 on the login
   limiter) and a scan of public/management responses and the web/admin build output for every generated
   secret.

## Host safety

- Container and compose names are unique (`zf-accept-<id>`), ports are chosen free and never include ports
  used by other services on shared hosts (4103, 4104, 4200-4202, 4281 and the stack defaults).
- Child processes (the registry) are stopped by exact PID; never use pattern kills on shared hosts.
- Only this run's compose project, volumes and built images are removed. Pulled base images and the shared
  BuildKit cache are left in place.
- Generated secrets stay in the generated `.env` (mode 0600) and in the command logs under `<work>/logs`.
