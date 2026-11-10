import { BlockRenderer, type BlockSlots } from '@zucker-framework/fe-blocks';
import type { SiteDocument } from '@zucker-framework/fe-site/content';
import { contentCopy } from './copy';
import { renderMarkdown } from './markdown';
import { localizedHref } from './types';

/**
 * Host slots every renderer gets: markdown through the template's markdown-it configuration (HTML
 * input disabled, links re-checked with safeSiteHref) and locale-aware links without a redirect hop.
 * Data slots (pricing, blog list, changelog) are server-only and come from features/landing/slots.
 */
export const baseSlots: BlockSlots = {
  markdown: ({ markdown, anchorPrefix, locale }) => (
    <div
      className="site-prose"
      dangerouslySetInnerHTML={{ __html: renderMarkdown(markdown, locale, anchorPrefix || 'section').html }}
    />
  ),
  resolveHref: localizedHref,
};

/**
 * Renders a CMS document: its markdown body (with an optional table of contents) followed by its
 * blocks through @zucker-framework/fe-blocks. Usable from Server and Client Components; data blocks
 * render only when the caller passes their slots, and are skipped otherwise.
 */
export function DocumentView({
  document,
  locale,
  showToc = false,
  slots,
  heroHeadingLevel,
  anchorPrefix = 'section',
}: {
  document: SiteDocument;
  locale: string;
  showToc?: boolean;
  slots?: BlockSlots;
  heroHeadingLevel?: 1 | 2;
  /** Heading anchor prefix of the markdown body; distinct per document when several share a page. */
  anchorPrefix?: string;
}) {
  const markdown = renderMarkdown(document.markdown, locale, anchorPrefix);
  const copy = contentCopy(locale);
  return (
    <div className={showToc ? 'grid gap-10 lg:grid-cols-[minmax(0,1fr)_200px]' : ''}>
      <div className="min-w-0 space-y-10">
        {document.markdown.trim() && (
          <div className="site-prose" dangerouslySetInnerHTML={{ __html: markdown.html }} />
        )}
        <BlockRenderer
          document={document}
          locale={locale}
          slots={{ ...baseSlots, ...slots }}
          renderDocumentMarkdown={false}
          heroHeadingLevel={heroHeadingLevel}
        />
      </div>
      {showToc && markdown.headings.length > 0 && (
        <aside className="hidden lg:block">
          <nav
            aria-label={copy.onThisPage}
            className="sticky top-24 border-l border-[var(--color-border)] pl-5 text-sm"
          >
            <p className="font-medium mb-4">{copy.onThisPage}</p>
            {markdown.headings.map((heading) => (
              <a
                key={heading.id}
                className="block mb-3 text-[var(--color-muted)] hover:text-primary-500"
                href={`#${heading.id}`}
              >
                {heading.title}
              </a>
            ))}
          </nav>
        </aside>
      )}
    </div>
  );
}
