# @zucker-framework/fe-blocks

React renderer and theme registry for landing blocks of a validated `@zucker-framework/fe-site`
site document (schema version 2). The package is fetch-free, uses no hooks and imports nothing from
Next.js, so the same renderer works as a React Server Component, in the browser and in an admin
preview. Its only runtime dependency is `@zucker-framework/fe-site` (schema types and
`safeSiteHref`); `react` 19 is a peer.

Content never executes. Blocks are plain text plus links, images and one form target. The package
contains no `dangerouslySetInnerHTML`; every link and media source is re-checked with
`safeSiteHref` at render time (also after the host's `resolveHref` mapping), and the newsletter
form target with `safeSiteFormAction` (https or same-origin path only). Markdown is rendered by a
host slot, which must keep HTML input disabled.

## Schema (from `@zucker-framework/fe-site/content`)

`validateSiteDocument(value)` accepts `version: 1` and `version: 2` and always returns a
`ValidatedSiteDocument` (`version: 2`). A version-1 input is upgraded by changing only `version`; it
may use only version-1 block types/fields. Errors are `SiteContentValidationError` with a dotted
`field` path (`blocks.3.items.0.image.src`). Limits are exported as `SITE_CONTENT_LIMITS`, block
types as `SITE_BLOCK_TYPES` (`SITE_BLOCK_TYPES_V1` for version 1).

Every block has `id` (`^[a-z][a-z0-9_-]*$`, unique, ≤ 64), `type`, `enabled` (default `true`) and
`heading` (required except for `markdown`, `logo-cloud`, `media`). A document holds ≤ 32 blocks
(≤ 20 for version 1) and ≤ 64 KiB of UTF-8 JSON. `SiteImage` is `{ src, alt, width?, height? }`;
`src` passes `safeSiteHref`, empty `alt` means decorative, dimensions are integers 1–8192.
`SiteAction` is `{ label, href }`.

| Type | Type-specific fields (`?` optional; defaults applied by the validator) |
| --- | --- |
| `hero` | `text?`, `action?`, `secondaryAction?`¹, `variant?`¹ `centered`\|`split`, `image?`¹ |
| `markdown` | `markdown` (≤ 24 000) |
| `features` | `items[≤12] {title, text}`, `variant?`¹ `grid`\|`list`, `image?`¹ |
| `faq` | `items[≤12] {question, answer}` |
| `cta` | `text?`, `action` |
| `links` | `items[≤20] SiteAction` |
| `logo-cloud`¹ | `items[≤24] {name, image, href?}` |
| `stats`¹ | `text?`, `items[≤8] {value (display text ≤ 32), label}` |
| `steps`¹ | `text?`, `items[≤12] {title, text}` |
| `testimonials`¹ | `items[≤12] {quote, author, role?, avatar?}` |
| `showcase`¹ | `text?`, `items[≤12] {title, text?, image, href?}` |
| `pricing`¹ | `text?`, `plans` = `'all'` or 1–12 unique plan slugs (`^[a-z0-9][a-z0-9_-]{0,63}$`), `showCreditPacks?` (false). Never prices. |
| `newsletter`¹ | `text?`, `formAction` (https URL or `/path`), `emailLabel`, `buttonLabel` |
| `blog-list`¹ | `text?`, `limit?` 1–12 (3), `category?` slug |
| `changelog`¹ | `text?`, `limit?` 1–20 (5) |
| `media`¹ | `kind` `image`\|`video`, `src`, `alt` (required), `caption?`, `poster?`, `width?`, `height?` |

¹ version 2 only. Omitted optional text fields come back as `''`; omitted optional objects are absent.

## Rendering

```tsx
import { BlockRenderer } from '@zucker-framework/fe-blocks';

<BlockRenderer
  document={visibleSiteDocument(document)}
  locale="en"
  heroHeadingLevel={1}
  slots={{
    markdown: ({ markdown, anchorPrefix }) => <SafeMarkdown source={markdown} prefix={anchorPrefix} />,
    pricing: ({ plans, showCreditPacks }) => <PlanCards slugs={plans} packs={showCreditPacks} />,
    blogList: ({ limit, category }) => <RecentPosts limit={limit} category={category} />,
    changelog: ({ limit }) => <RecentChanges limit={limit} />,
    resolveHref: (href, locale) => (href.startsWith('/') ? `/${locale}${href}` : href),
  }}
  onIssue={(issue) => console.warn('site block issue', issue)}
/>;
```

`BlockRendererProps`:

| Prop | Meaning |
| --- | --- |
| `document` | `{ blocks, markdown }` of a validated document. Disabled blocks are skipped. |
| `theme?` | A `SiteBlockTheme`; default `defaultTheme`. |
| `locale` | Passed to slots and `resolveHref`. |
| `slots?` | `markdown`, `pricing`, `blogList`, `changelog`, `newsletter` (optional form override), `resolveHref`. Slots return React nodes. |
| `onIssue?` | `(issue: BlockRenderIssue) => void`, called synchronously during render; may repeat. |
| `renderDocumentMarkdown?` | Render `document.markdown` through `slots.markdown` (anchor prefix `''`) before the blocks. Default `true`. |
| `heroHeadingLevel?` | `1` or `2` (default) for hero headings. |
| `className?` | Root classes, default `flex flex-col gap-16`. The root carries `data-zb-theme` and the theme's CSS variables. |

Each block renders as `<section id={block.id} data-block-type={block.type}>`.
`BlockRenderIssue` is `{ code, blockId?, blockType, theme, slot?, field? }` with codes:
`unknown-block` (no renderer in theme or default; skipped), `theme-fallback` (default theme used),
`missing-slot` (`pricing`/`blog-list`/`changelog` skipped; markdown falls back to plain text) and
`unsafe-href` (link, image or form omitted). `planBlocks(document, theme)` returns the enabled
blocks with their components and the `unknown-block`/`theme-fallback` issues without rendering.

## Themes

```ts
import { defineTheme, resolveThemeBlock } from '@zucker-framework/fe-blocks';

export const editorial = defineTheme({
  name: 'editorial',
  tokens: { '--zb-accent': '#0f766e', '--zb-radius': '0.25rem' },
  blocks: { hero: EditorialHero },        // BlockComponent<'hero'>: ({ block, context }) => ReactNode
});
resolveThemeBlock(editorial, 'faq');      // { component, themeName: 'default', usedFallback: true }
```

`defineTheme` freezes the theme and rejects invalid names (`^[a-z][a-z0-9-]{0,63}$`), unknown block
types and token values that could escape a style declaration. Lookup is **theme → default theme**;
`null` means skip and report. A theme component receives `{ block, context }`, where `context`
offers `locale`, `theme`, `slots`, `heroHeadingLevel`, `href(value, field)` (safe and
locale-mapped), `src(value, field)` (safe media source) and `report(issue)`. Components must be pure
(no hooks) to stay usable in Server Components. Pick a registered theme from a stored name with
fe-site `resolveSiteTheme(name, ['default', 'editorial'])`.

The default theme uses Tailwind utility classes coloured through CSS variables:
`--zb-bg`, `--zb-fg`, `--zb-surface`, `--zb-border`, `--zb-muted`, `--zb-accent`, `--zb-accent-fg`,
`--zb-radius`, `--zb-radius-sm` (`DEFAULT_THEME_TOKENS`). They default to the host's
`--color-background`, `--color-foreground`, `--color-card`, `--color-border`, `--color-muted` and
`--color-primary-600`, then to CSS system colours, so blocks follow the host's light/dark palette.
A Tailwind v4 host must scan the package output, for example in its global stylesheet:

```css
@source "../../node_modules/@zucker-framework/fe-blocks/dist";
```
