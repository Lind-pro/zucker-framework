import type { ReactNode } from 'react';
import type {
  SiteBlockOf,
  SiteBlockType,
  SiteBlogListBlock,
  SiteChangelogBlock,
  SiteNewsletterBlock,
  SitePricingBlock,
} from '@zucker-framework/fe-site/content';

/**
 * A problem found while rendering. Rendering never throws for content problems: the affected block
 * (or link) is skipped and an issue is reported so an editor preview can show it.
 *
 * - `unknown-block`: neither the theme nor the default theme renders this `blockType`; skipped.
 * - `theme-fallback`: the selected theme has no component for this type; the default theme's is used.
 * - `missing-slot`: a host slot (`slot`) the block needs was not supplied; data blocks are skipped,
 *   markdown falls back to plain text.
 * - `unsafe-href`: a link/image/form target (`field`) failed `safeSiteHref` after host resolution;
 *   the link or image is omitted.
 */
export interface BlockRenderIssue {
  code: 'unknown-block' | 'theme-fallback' | 'missing-slot' | 'unsafe-href';
  /** Absent for document-level issues (the document's own markdown). */
  blockId?: string;
  blockType: string;
  theme: string;
  slot?: keyof BlockSlots;
  field?: string;
}

export interface MarkdownSlotProps {
  markdown: string;
  /** Prefix for heading anchors: `''` for the document body, `block-<id>` for a markdown block. */
  anchorPrefix: string;
  locale: string;
}
export interface PricingSlotProps {
  block: SitePricingBlock;
  /** Plan slugs in authoring order, or `'all'` for every public plan. Never prices. */
  plans: 'all' | readonly string[];
  showCreditPacks: boolean;
  locale: string;
}
export interface BlogListSlotProps {
  block: SiteBlogListBlock;
  limit: number;
  category?: string;
  locale: string;
}
export interface ChangelogSlotProps {
  block: SiteChangelogBlock;
  limit: number;
  locale: string;
}
export interface NewsletterSlotProps {
  block: SiteNewsletterBlock;
  /** `block.formAction` re-checked with `safeSiteFormAction`. */
  formAction: string;
  locale: string;
}

/**
 * Host-supplied render functions and policies. The package never fetches: data-backed blocks
 * (`pricing`, `blog-list`, `changelog`) render only what these slots return, inside the block's
 * section and heading. Slots must return React nodes, never HTML strings; a markdown slot that
 * needs HTML output is the host's responsibility to sanitise (HTML input disabled).
 */
export interface BlockSlots {
  markdown?: (props: MarkdownSlotProps) => ReactNode;
  pricing?: (props: PricingSlotProps) => ReactNode;
  blogList?: (props: BlogListSlotProps) => ReactNode;
  changelog?: (props: ChangelogSlotProps) => ReactNode;
  /** Optional replacement for the default plain `POST` newsletter form. */
  newsletter?: (props: NewsletterSlotProps) => ReactNode;
  /**
   * Maps a validated navigation href for the locale (for example `/pricing` → `/en/pricing`).
   * Its result is checked with `safeSiteHref` again; an unsafe result drops the link. Not applied
   * to image/video sources or form actions.
   */
  resolveHref?: (href: string, locale: string) => string;
}

/** What a theme block component receives besides its block. */
export interface BlockContext {
  locale: string;
  theme: string;
  slots: BlockSlots;
  /** Heading element for `hero` blocks; the default theme uses `h2` unless the host asks for `h1`. */
  heroHeadingLevel: 1 | 2;
  /** Safe, locale-resolved navigation href, or `null` (reported as `unsafe-href`). */
  href(value: string | undefined, field: string): string | null;
  /** Safe media source (no locale mapping), or `null` (reported as `unsafe-href`). */
  src(value: string | undefined, field: string): string | null;
  report(issue: Pick<BlockRenderIssue, 'code' | 'slot' | 'field'>): void;
}

export interface BlockComponentProps<T extends SiteBlockType> {
  block: SiteBlockOf<T>;
  context: BlockContext;
}
/** Must be a pure function component (no hooks) so the renderer works in React Server Components. */
export type BlockComponent<T extends SiteBlockType> = (props: BlockComponentProps<T>) => ReactNode;
export type ThemeBlocks = { [T in SiteBlockType]?: BlockComponent<T> };

export interface SiteBlockTheme {
  readonly name: string;
  readonly blocks: Readonly<ThemeBlocks>;
  /** CSS custom properties (`--zb-*`) applied on the renderer root, merged over the default theme's. */
  readonly tokens: Readonly<Record<string, string>>;
}
