---
name: page-builder
description: "Add or edit one landing page of the generated site as a version-2 block document (hero, features, pricing, FAQ, testimonials and the other block types) under apps/server/content/pages, validate it with content:check and publish it through content:seed or the admin editor. Use for home page or marketing page copy and layout; not for React components or new block types."
---

# Page builder

Landing pages are data, not code: a JSON block document rendered by the web app's block renderer.
The block catalogue with every field and limit is
[references/blocks.md](references/blocks.md). It is generated from the installed validator; when it
and `content:check` disagree, `content:check` is right.

## Where pages live

- File: `apps/server/content/pages/<slug>.<locale>.json`, locale `en` or `zh`, one file per locale.
  Slugs are lowercase `a-z0-9` words joined by `-`; sub-folders make nested slugs
  (`pages/solutions/teams.en.json` serves `/solutions/teams`). Max 256 KiB per file.
- `home` is the site root `/` (and `/zh` for the other locale). Any other slug is served at `/<slug>`.
- Reserved first segments (rejected): `api`, `account`, `billing`, `pricing`, `blog`, `docs`,
  `content`, `dashboard`, `changelog`, `login`, `register`, `verify-email`, `forgot-password`,
  `reset-password`, `oauth`, `en`, `zh`, `sitemaps`. Also avoid any folder that already exists under
  `apps/web/src/app/[locale]/` (for example `ai`, `chat`, `magic-link`): the app route wins.
- File shape: `{ "publishedAt": "YYYY-MM-DD", "document": { "version": 2, ... } }`, nothing else.

## Steps

1. Ask for the page goal, audience, slug, locales and the facts to show. Do not invent customer
   names, logos, testimonials, statistics or awards; use clearly marked placeholders the user must
   replace, or leave the block out.
2. Start from the existing `pages/home.<locale>.json` when it fits; it shows every common block.
3. Choose blocks from the catalogue. Typical order: `hero`, `logo-cloud` or `stats`, `features`,
   `steps` or `showcase`, `testimonials`, `pricing`, `faq`, `cta`. Give each block a unique,
   descriptive `id` (`hero`, `features-teams`).
4. Prices never go into content: use a `pricing` block with `"plans": "all"` or plan slugs; prices,
   currencies and credits come from the plans edited in the admin. Plans show as "not purchasable"
   until a payment provider is enabled.
5. Links: site paths (`/pricing`, `/register`, `/docs/getting-started`) or `https://` URLs. Images:
   files in `apps/web/public/` referenced as `/name.png`, or URLs returned by the admin's image
   upload. Every non-decorative image needs `alt` text.
6. Fill `title`, `description` and, when useful, `seo.title`/`seo.description` (search snippet).
   Set `"enabled": false` on a block to keep it out of the public page while drafting.
7. Write the same page for every locale the product ships, translated, not copied.

## Validate

```bash
pnpm --filter ./apps/server content:check
```

It validates every file under `apps/server/content` with the server's own rules and exits 1 on any
problem, printing `invalid <file>: <reason> (<field path>)`, for example
`invalid pages/about.en.json: Invalid document: Text is required (blocks.1.items.0.title)`. Fix and
rerun until it reports `0 invalid`.

## Publish

How a file reaches the site:

- The server reads `content/` at startup and serves valid files as published pages, unless a
  **published** CMS entry with the same kind, locale and slug exists (the CMS wins). Restart the
  server to pick up file edits (its watch mode does not watch `content/`).
- `pnpm --filter ./apps/server content:seed` copies files into the CMS as drafts
  (`-- --publish` to publish them). Entries that already exist are never changed, so seeding cannot
  overwrite edits made in the admin. It needs the database from `.env`; run it through the root
  wrapper: `node scripts/with-env.mjs pnpm --filter ./apps/server content:seed`.
- Once a slug exists in the CMS (the home page does after `pnpm setup:admin`), edit it in the admin:
  Pages, blog & docs. The block editor there uses the same validator and limits.

## Verify in the browser

Open http://localhost:4202/<slug> (the non-default locale is under its prefix, e.g. `/zh/<slug>`) in light and dark mode and on a
narrow window. Check headings, button targets, image alt text and that the pricing block shows the
plans you expect. Report anything you could not check.

Do not add new block types or edit the renderer here: block types come from the installed
`@zucker-framework/fe-site` and `@zucker-framework/fe-blocks` versions.
