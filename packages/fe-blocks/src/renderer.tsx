import type { CSSProperties, ReactNode } from 'react';
import { safeSiteHref, type SiteDocument } from '@zucker-framework/fe-site/content';
import { defaultTheme } from './default-theme';
import { planBlocks } from './resolve';
import type { BlockContext, BlockRenderIssue, BlockSlots, SiteBlockTheme } from './types';

export interface BlockRendererProps {
  /** A document returned by fe-site `validateSiteDocument`/`visibleSiteDocument`. */
  document: Pick<SiteDocument, 'blocks' | 'markdown'>;
  /** Defaults to `defaultTheme`. Blocks the theme lacks fall back to the default theme. */
  theme?: SiteBlockTheme;
  locale: string;
  slots?: BlockSlots;
  /**
   * Receives every issue (see `BlockRenderIssue`). Called synchronously during render, so it may
   * run more than once for the same issue (Strict Mode, re-renders): log or collect idempotently.
   */
  onIssue?: (issue: BlockRenderIssue) => void;
  /** Render `document.markdown` through `slots.markdown` before the blocks. Default `true`. */
  renderDocumentMarkdown?: boolean;
  /** Heading element for hero blocks: `1` on a landing page without another `h1`. Default `2`. */
  heroHeadingLevel?: 1 | 2;
  /** Root element classes. Default `flex flex-col gap-16`. */
  className?: string;
}

/**
 * Renders enabled blocks of a validated site document with the selected theme. Pure and
 * fetch-free, uses no hooks or context, and imports nothing from Next.js, so it works as a React
 * Server Component, in the browser and in an admin preview alike.
 */
export function BlockRenderer({
  document,
  theme = defaultTheme,
  locale,
  slots = {},
  onIssue,
  renderDocumentMarkdown = true,
  heroHeadingLevel = 2,
  className = 'flex flex-col gap-16',
}: BlockRendererProps): ReactNode {
  const { blocks, issues } = planBlocks(document, theme);
  for (const issue of issues) onIssue?.(issue);
  const tokens = { ...defaultTheme.tokens, ...theme.tokens } as CSSProperties;

  const contextFor = (blockId: string | undefined, blockType: string): BlockContext => {
    const report: BlockContext['report'] = (issue) =>
      onIssue?.({
        ...issue,
        ...(blockId === undefined ? {} : { blockId }),
        blockType,
        theme: theme.name,
      });
    const unsafe = (field: string) => {
      report({ code: 'unsafe-href', field });
      return null;
    };
    return {
      locale,
      theme: theme.name,
      slots,
      heroHeadingLevel,
      report,
      href(value, field) {
        // Re-checked on both sides of the host mapping: the renderer never trusts its input or slot.
        const safe = safeSiteHref(value);
        if (!safe) return unsafe(field);
        const mapped = slots.resolveHref ? safeSiteHref(slots.resolveHref(safe, locale)) : safe;
        return mapped ?? unsafe(field);
      },
      src(value, field) {
        return safeSiteHref(value) ?? unsafe(field);
      },
    };
  };

  let body: ReactNode = null;
  if (renderDocumentMarkdown && document.markdown.trim()) {
    if (slots.markdown)
      body = slots.markdown({ markdown: document.markdown, anchorPrefix: '', locale });
    else {
      contextFor(undefined, 'document').report({ code: 'missing-slot', slot: 'markdown' });
      body = <p className="whitespace-pre-line">{document.markdown}</p>;
    }
  }

  return (
    <div className={className} data-zb-theme={theme.name} style={tokens}>
      {body}
      {blocks.map(({ block, resolved }) => {
        const Component = resolved.component;
        return (
          <Component key={block.id} block={block} context={contextFor(block.id, block.type)} />
        );
      })}
    </div>
  );
}
