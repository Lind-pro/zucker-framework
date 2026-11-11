# __NAME__

An AI SaaS workspace created by `zucker create`, built on released `@zucker-framework/*` packages.

| App | Path | Local URL |
| --- | --- | --- |
| Server (NestJS, PostgreSQL) | `apps/server` | http://localhost:4200/api |
<!-- <zucker:web> -->
| Web (Next.js: site and user console) | `apps/web` | http://localhost:4202 |
<!-- </zucker:web> -->
<!-- <zucker:admin> -->
| Admin (back office) | `apps/admin` | http://localhost:4201 |
<!-- </zucker:admin> -->

Supporting services in `docker-compose.yml`: PostgreSQL, Redis (shared rate-limit budgets), SeaweedFS
(S3-compatible private files, service `minio`) and Mailpit (catches all mail, UI at http://localhost:8025).

## Configuration

There is one configuration file: the root `.env`. `zucker create` generated it with random secrets
(`JWT_SECRET`, `CONFIG_ENCRYPTION_KEY`, `REVALIDATE_SECRET`, database, Redis and storage passwords)
and file mode 0600. It is ignored by Git and by Docker builds; `.env.example` documents every key.
Keep `CONFIG_ENCRYPTION_KEY` stable: it protects provider settings saved in the back office.
Apps read the root `.env` through `scripts/with-env.mjs`, so do not copy it into `apps/*`.

## Develop on the host

```bash
pnpm install            # first install writes pnpm-lock.yaml; commit it
pnpm dev:infra          # PostgreSQL, Redis, S3 storage and Mailpit in Docker
pnpm db:migrate         # apply the Prisma migrations
pnpm dev                # all apps in watch mode
```

Create the first administrator explicitly (no default account exists): set `BOOTSTRAP_ADMIN_USERNAME`,
`BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD` in `.env`, run `pnpm setup:admin`, then remove
the password from `.env`.

## Run everything in Docker

```bash
pnpm install                       # the images build from pnpm-lock.yaml
docker compose up -d --build       # migrate runs once, then the server and the browser apps start
docker compose run --rm migrate node_modules/.bin/tsx src/scripts/create-admin.ts
```

The server is healthy when `GET /api/health/ready` returns 200 (database reachable and schema migrated).
Web and admin listen on `PUBLIC_BIND` (127.0.0.1 by default). Put a TLS reverse proxy in front before
exposing them, then set `SITE_URL`, `WEB_URL`, `ADMIN_URL` and `ACCOUNT_ORIGINS` to the public origins.
Web bakes `API_URL`, `SITE_URL` and `DEFAULT_LOCALE` in at build time; rebuild its image after changing them.

## Deploy

- Each app has a multi-stage `Dockerfile` (Node 24 Alpine, non-root). Build with the workspace root as
  context, e.g. `docker build -f apps/server/Dockerfile --target runtime .`. Run the `migrate` target
  (`prisma migrate deploy`) as a separate release step before new server replicas start.
- `.github/workflows/image.yml.example` builds and pushes the three images to GHCR; rename it to
  `image.yml` to enable it.
- `vercel.json.example` is a starting point for hosting `apps/web` on Vercel (root directory `apps/web`).
- Production needs: HTTPS origins, `NODE_ENV=production`, an S3 bucket (`FILES_STORAGE_PROVIDER=s3`),
  `RATE_LIMIT_REDIS_URL` when running more than one server replica, real SMTP settings and
  `TRUST_PROXY` matching your proxy hops.

Run `pnpm doctor` to check configuration, database reachability and schema readiness.
Read `AGENTS.md` before extending the application.
