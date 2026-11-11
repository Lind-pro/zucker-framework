---
name: brand-quickstart
description: "First run and first customisation of a workspace created by zucker create: start the stack locally, then apply the product name, tagline, colours, logo, locales and starter copy within a strict file allow-list. Use for initial branding, renaming the starter or replacing placeholder copy; not for new features, providers or deployment."
---

# Brand quick start

Turns the generated starter into the user's product on their machine. Everything here is local file
editing plus commands the user runs; nothing calls an external service.

## Layout

A `zucker create` workspace has `apps/server` (NestJS API, content files), `apps/web` (Next.js site
and user console), `apps/admin` (back office) and one root `.env`. `--no-web`/`--no-admin` projects
lack those apps: skip their steps. A single app created by `zucker init` has no `apps/<name>/`
prefix; drop it from every path below.

## 1. Collect the brief first

Ask for anything missing; never invent it.

| Item | Used for |
| --- | --- |
| Product name | `SITE_NAME` (mail), admin title, README, site settings |
| Tagline and one-paragraph description | home hero, site description, README |
| Primary colour (hex) | web theme scale |
| Logo file (SVG or PNG) and favicon | `apps/web/public/`, site settings logo |
| Production domain | README and legal pages only; origins change at deployment |
| Locales (`en`, `zh` or both) and default | `DEFAULT_LOCALE`, which content files to write |
| Legal entity name and contact address | privacy, terms and refund placeholders |

## 2. Start it locally (only if not running yet)

```bash
pnpm install
pnpm dev:infra        # PostgreSQL, Redis, MinIO, Mailpit in Docker
pnpm db:migrate
pnpm dev              # server :4200, web :4202, admin :4201
```

Do not run `pnpm setup:admin` yet if the user wants their own starter copy: it publishes
`apps/server/content` into the CMS once (see step 4). The user sets `BOOTSTRAP_ADMIN_*` in `.env`
themselves; never write, print or choose a password for them.

## 3. Allowed changes

[references/allowlist.json](references/allowlist.json) is the machine-readable allow-list. Edit only
those paths, only in the stated way. Everything else is out of scope for this skill, in particular:
any other `.env` key or secret, `apps/server/prisma/**`, `apps/server/src/**` (billing, accounts,
policies), `package.json` files, `pnpm-lock.yaml`, Dockerfiles, `docker-compose.yml`, `.github/**`.
If the brief needs one of those, stop and say which skill or decision it needs.

- **Name and locale**: in the root `.env` set `SITE_NAME` (mail subjects; empty uses the host of
  `WEB_URL`), and keep `DEFAULT_LOCALE` and `VITE_DEFAULT_LOCALE` equal (`en` or `zh`). Web reads the
  locale at build time: restart `pnpm dev` after changing it.
- **Colours**: replace the `primary` 50 to 950 scale in `apps/web/tailwind.config.ts` (derive a full
  scale from the brand hex; keep 500 close to it). Adjust only the `--color-*` variables in
  `apps/web/src/app/globals.css` for background and surfaces. Check contrast of text on
  `primary-600` and on both light and dark backgrounds.
- **Logo and icon**: copy the user's files into `apps/web/public/` (create it), e.g. `/logo.svg`.
  For the browser icon use Next.js file conventions: `apps/web/src/app/icon.svg` (or `icon.png`) and
  optionally `apple-icon.png`. Never download images from the internet.
- **Shell strings**: `apps/web/src/messages/en.json` and `zh.json`. Change values only, never keys;
  keep both files with the same keys.
- **Admin title**: the `<title>` element of `apps/admin/index.html`.
- **README.md**: replace the starter description with the product's.

## 4. Starter content

Content files live in `apps/server/content/` (format: `apps/server/content/README.md`):
`pages/home.<locale>.json` (landing blocks, use the `page-builder` skill), `pages/privacy`,
`pages/terms`, `pages/refund`, `posts/hello-world`, `docs/getting-started`, `logs/first-release`.

- Rewrite the hero, features and FAQ of `home.<locale>.json` with the brief. Keep the `pricing`,
  `blog-list` and `changelog` blocks: they read live data; never type prices into content.
- Put the legal entity and contact address into the legal pages, keep the placeholder warning
  sentence, and tell the user they must be reviewed by a qualified person before launch.
- Replace or remove the sample post, doc and changelog entry (front matter keys: `title`,
  `description`, `publishedAt`, `authorName`, `noIndex`).
- Write one file per locale the product ships.

How file content reaches the site: the server reads `content/` once at startup, and a **published**
CMS entry with the same kind, locale and slug wins over the file. `pnpm setup:admin` publishes the
files into the CMS once. So:

- before `setup:admin`: edit the files, restart the server, then run `setup:admin`;
- after `setup:admin`: file edits to those slugs no longer show. Ask the user to edit them in the
  admin (Pages, blog & docs) instead; new slugs still work from files after a restart.

## 5. Settings that live in the admin, not in files

Site name shown on the web, description per locale, navigation, footer links, logo URL, social links,
banner and default appearance are **Site settings** in the admin (`/config`, permission
`content:manage`). Give the user the exact values to enter (name, description, `logoUrl` such as
`/logo.svg`, nav labels). Do not log in on their behalf or use their credentials.

## 6. Verify

```bash
pnpm --filter ./apps/server content:check   # every content file validates; prints field paths
pnpm lint
```

Then open http://localhost:4202 (and `/zh` if both locales ship) and the admin at
http://localhost:4201, and check the name, colours, logo and copy in light and dark mode. Finish by
reminding the user: the legal pages are placeholders and must be reviewed before launch.
