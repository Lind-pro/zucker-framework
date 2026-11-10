# Starter content

Documents here are served as published content at startup. A **published** CMS entry with the same
kind, locale and slug replaces the file version, so admins can take over any page without a deploy.
`pnpm content:seed` copies these files into the CMS as drafts (`--publish` to publish them); entries
that already exist are never changed. `pnpm account:admin` (first administrator setup) publishes them
into the CMS once, in the same transaction, so the starter site is editable from the admin right away.
The home page (`pages/home.*.json`) is a version-2 block document: hero, features, pricing (all plans
plus credit packs), latest blog posts, changelog, FAQ and a call to action.

Layout: `pages/`, `posts/` (blog), `docs/` and `logs/` (changelog), each holding
`<slug>.<zh|en>.md` or `<slug>.<zh|en>.json`. Pages and docs may use sub-folders for nested slugs.

Markdown files start with front matter (plain `key: value` lines, no other YAML):

```
---
title: Required title
description: Optional summary
publishedAt: 2026-01-01
authorName: Optional author
noIndex: false
---
Markdown body (HTML is not rendered).
```

JSON files contain `{"publishedAt": "2026-01-01", "document": { ...site document... }}` and are
validated exactly like documents saved in the admin. Symbolic links are ignored.

The legal pages are placeholders. Replace them with text reviewed for your business and
jurisdictions before launch.
