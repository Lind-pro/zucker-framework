---
name: deploy-checklist
description: "Prepare a zucker create workspace for production and review it before launch: required environment, public origins, migrations as a release step, Docker images, reverse proxy and TLS, storage, Redis, mail, payment webhooks and post-deploy checks. Use when the user asks how to deploy or wants a launch review; it prepares and checks locally and never deploys, pushes or builds release images on its own."
---

# Deploy checklist

Deploying, pushing images, creating cloud resources, changing DNS and touching a production database
are actions the user takes or explicitly asks for, one stage at a time. This skill prepares the
project, explains each step and checks what can be checked locally. It never reads, prints or copies
production secrets.

## 1. Choose the topology with the user

The workspace ships what each option needs:

| Option | What exists | Notes |
| --- | --- | --- |
| One host with Docker Compose | `docker-compose.yml`, one `Dockerfile` per app | Replace the local PostgreSQL, MinIO and Mailpit with managed services or keep them with backups; add a TLS reverse proxy. |
| Container platform | `apps/<app>/Dockerfile` targets `runtime` (and `migrate` for the server); `.github/workflows/image.yml.example` builds and pushes images to GHCR | Rename the workflow to `image.yml` only when the user wants CI image builds. |
| Web on Vercel | `vercel.json.example` (root directory `apps/web`) | The server and admin still need a host; set `API_URL` to the server's public `/api`. |

Images are built with the workspace root as context, for example
`docker build -f apps/server/Dockerfile --target runtime .`, and need a committed `pnpm-lock.yaml`.

## 2. Production environment

Configure these in the deployment platform's secret store, not in tracked files. `.env.example` at
the root documents every key.

- `NODE_ENV=production`. Never set `BILLING_TEST_FAKE_PROVIDER` or `AI_TEST_FAKE_PROVIDERS`: the server
  refuses to start with them in production.
- New random values for production (do not reuse the development ones): `JWT_SECRET`,
  `CONFIG_ENCRYPTION_KEY`, `REVALIDATE_SECRET` (same value on server and web), database and storage
  credentials. The three keys need at least 32 random characters and must differ from each other.
  `CONFIG_ENCRYPTION_KEY` must then stay stable: it decrypts
  provider settings saved in the admin and two-factor secrets.
- Origins, all `https://`, no path: `WEB_URL` and `SITE_URL` = the public site origin (identical),
  `ADMIN_URL` = the admin origin, `ACCOUNT_ORIGINS` = every browser origin (site and admin).
- `DATABASE_URL` for this product's own database. `RATE_LIMIT_REDIS_URL` when more than one server
  replica runs. `TRUST_PROXY` = the number of proxy hops or the proxy addresses in front of the server
  (never `true`).
- Storage: `FILES_STORAGE_PROVIDER=s3` with a private bucket (`FILES_S3_*`); local storage is refused
  in production. Add a bucket rule that aborts incomplete multipart uploads after a day.
- Real mail (see the `provider-setup` skill) or sign-up verification mail will fail.
- Web build-time values: `API_URL`, `SITE_URL` and `DEFAULT_LOCALE` are fixed when the web image is
  built (build args in `docker-compose.yml`); admin bakes `VITE_DEFAULT_LOCALE`. Rebuild after
  changing them.

## 3. Release order

1. Build the images (or let CI build them) from a clean, committed tree.
2. Run the server `migrate` target (`prisma migrate deploy`) once against the production database,
   **before** new server replicas start. The server never migrates on start-up. Take a database
   backup first; never use `db push` or reset commands on production.
3. Start the server; it is ready when `GET /api/health/ready` returns 200.
4. Start web and admin. Admin is static files behind nginx that forwards `/api/*` to the server
   (`API_UPSTREAM`); web forwards `/api/*` to `API_URL`.
5. First administrator, once: set `BOOTSTRAP_ADMIN_USERNAME`, `BOOTSTRAP_ADMIN_EMAIL` and
   `BOOTSTRAP_ADMIN_PASSWORD` for a one-off run of `src/scripts/create-admin.ts` (in Compose:
   `docker compose run --rm migrate node_modules/.bin/tsx src/scripts/create-admin.ts`), then remove
   the password from the environment.

## 4. Network

- Terminate TLS at a reverse proxy or load balancer. Web and admin containers bind to `PUBLIC_BIND`
  (default `127.0.0.1`); expose them only through the proxy. Datastores stay private.
- Register external callbacks with the production origins: payment webhooks
  `https://<site>/api/billing/webhooks/<provider>`, OAuth callbacks
  `https://<site>/api/authorize/oauth/<google|github>/callback`, AI media callbacks
  `https://<site>/api/ai/tasks/callbacks/<id>`.
- Payment providers in live mode use a different account scope label from test mode.

## 5. Checks you can run locally

```bash
pnpm lint
pnpm build
pnpm --filter ./apps/server content:check
pnpm doctor            # secrets present and long enough, origin consistency, database and schema
docker compose up -d --build   # optional full local rehearsal with production NODE_ENV
```

Review before launch, and report each item as checked or open:

- legal pages (privacy, terms, refund) reviewed for the business and jurisdictions;
- plans, prices and credit packs correct in the admin, test purchase and refund done in test mode;
- sign-up, verification mail, password reset and login on the public origin;
- `robots.txt`, `sitemap.xml`, page titles and Open Graph images use the public origin;
- the admin is reachable only by staff accounts; roles grant only needed permissions;
- backups and restore of the database and the bucket are tested; logs do not contain secrets.

## 6. After deployment (with the user)

Check `GET /api/health/ready`, sign up a test account, run one test-mode purchase if live keys are not
yet enabled, confirm webhooks arrive (admin Orders), and watch the server log for errors. Switch
payment providers to live mode only after that, as a separate, explicit step.
