# Landing block catalogue

<!-- Generated from @zucker-framework/fe-site (content.ts) by the framework's
     scripts/prepare-skill-block-catalogue.mjs. Do not edit by hand. -->

The block document format validated by `validateSiteDocument` (version 2). Every page file and
every document saved in the admin goes through the same validator; `content:check` runs it over
`apps/server/content` and prints the exact field path of each problem.

## Document

```json
{ "publishedAt": "2026-01-01", "document": {
  "version": 2, "title": "Required title", "description": "", "authorName": "", "markdown": "",
  "blocks": [], "seo": { "title": "", "description": "", "noIndex": false } } }
```

- `title` is required (200 characters); `description` 500; `authorName` 120; `markdown` 48000.
- At most 32 blocks; the serialized document must stay under 65536 bytes.
- `seo.title` (200) and `seo.description` (500) override the page title and description; `seo.noIndex` hides the page from search engines.
- Unknown fields are rejected everywhere. There is no HTML, script, style or component field.

## Fields every block has

- `id`: required, unique in the document, lowercase `[a-z][a-z0-9_-]*`, up to 64 characters.
- `type`: one of `hero`, `markdown`, `features`, `faq`, `cta`, `links`, `logo-cloud`, `stats`, `steps`, `testimonials`, `showcase`, `pricing`, `newsletter`, `blog-list`, `changelog`, `media`.
- `enabled`: optional, default `true`. `false` keeps the block in the draft but removes it from the public page.
- `heading`: up to 200 characters; required except for `markdown`, `logo-cloud`, `media`.

## Links and images

- Links (`href`, `src`, `poster`): `https://`/`http://` URLs, site paths such as `/pricing`, or `#fragment`; at most 2048 characters. No `javascript:`, `data:`, `//host`, spaces, backslashes or user:password.
- Images are `{ "src", "alt", "width"?, "height"? }`; `alt` up to 300 characters (empty only for decorative images); dimensions 1 to 8192.
- Upload images in the admin block editor (public assets) and use the returned URL, or put the file in `apps/web/public/` (create the folder) and use `/name.png`.

## Block types

### `hero`

Top-of-page pitch with up to two buttons.

- `text`: optional supporting text, up to 4000 characters
- `action`: optional primary button `{ "label", "href" }` (label up to 100)
- `secondaryAction`: optional second button, same shape as `action`
- `variant`: `"centered"` (default) or `"split"` (text beside `image`)
- `image`: optional image (see Links and images)

### `markdown`

Free text. Markdown is rendered with HTML disabled.

- `markdown`: required Markdown text, up to 24000 characters

### `features`

Feature grid or list.

- `items`: up to 12 items `{ "title" (required, 160), "text" (required, 4000) }`
- `variant`: `"grid"` (default) or `"list"`
- `image`: optional image shown beside the list

### `faq`

Questions and answers.

- `items`: up to 12 items `{ "question" (required, 300), "answer" (required, 4000) }`

### `cta`

Call to action with one required button.

- `text`: optional text, up to 4000 characters
- `action`: required button `{ "label", "href" }`

### `links`

A list of links.

- `items`: up to 20 items `{ "label" (required, 100), "href" }`

### `logo-cloud` (version 2)

Customer or partner logos. Use only logos you have permission to show.

- `items`: up to 24 items `{ "name" (required, 120), "image" (required), "href" (optional) }`

### `stats` (version 2)

Headline numbers. `value` is display text ("99.9%", "10k+"), never computed.

- `text`: optional text, up to 4000 characters
- `items`: up to 8 items `{ "value" (required, 32), "label" (required, 120) }`

### `steps` (version 2)

Numbered how-it-works steps.

- `text`: optional text, up to 4000 characters
- `items`: up to 12 items `{ "title" (required, 160), "text" (required, 4000) }`

### `testimonials` (version 2)

Quotes. Only real quotes from real customers, with their permission; never invent them.

- `items`: up to 12 items `{ "quote" (required, 1200), "author" (required, 120), "role" (optional, 160), "avatar" (optional image) }`

### `showcase` (version 2)

Cards with an image each (examples, use cases, screenshots).

- `text`: optional text, up to 4000 characters
- `items`: up to 12 items `{ "title" (required, 160), "text" (optional, 1000), "image" (required), "href" (optional) }`

### `pricing` (version 2)

Plans and credit packs from the billing catalogue. Never write prices, currencies or credits here: the site reads them from the plans edited in the admin.

- `text`: optional text, up to 4000 characters
- `plans`: `"all"` or a list of up to 12 unique plan slugs (lowercase, `[a-z0-9_-]`)
- `showCreditPacks`: `true` to list credit packs as well (default `false`)

### `newsletter` (version 2)

A plain POST form with one `email` field. The starter ships no newsletter endpoint: point it at one you own.

- `text`: optional text, up to 4000 characters
- `formAction`: required: an `https://` URL or a same-origin path such as `/api/newsletter`
- `emailLabel`: required field label, up to 100 characters
- `buttonLabel`: required button label, up to 100 characters

### `blog-list` (version 2)

Latest blog posts (filled in by the site).

- `text`: optional text, up to 4000 characters
- `limit`: integer 1 to 12 (default 3)
- `category`: optional blog category slug

### `changelog` (version 2)

Latest changelog entries (filled in by the site).

- `text`: optional text, up to 4000 characters
- `limit`: integer 1 to 20 (default 5)

### `media` (version 2)

One image or video.

- `kind`: required: `"image"` or `"video"`
- `src`: required link to the file (see Links and images)
- `alt`: required description, up to 300 characters (also the video's accessible name)
- `caption`: optional caption, up to 500 characters
- `poster`: optional poster image link for a video
- `width`: optional integer 1 to 8192
- `height`: optional integer 1 to 8192
