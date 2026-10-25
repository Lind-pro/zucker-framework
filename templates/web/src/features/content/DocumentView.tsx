import type { SiteBlock, SiteDocument } from '@zucker-framework/fe-site/content';
import { renderMarkdown } from './markdown';
import { localizedHref } from './types';

const panel = 'rounded-2xl border border-[var(--color-border)] bg-[var(--color-card)] p-6';
function Action({ action, locale }: { action: { label: string; href: string }; locale: string }) {
  return (
    <a
      className="inline-flex rounded-lg bg-primary-600 px-5 py-3 font-medium text-white hover:bg-primary-700"
      href={localizedHref(action.href, locale)}
    >
      {action.label}
    </a>
  );
}
function Block({ block, locale }: { block: SiteBlock; locale: string }) {
  if (!block.enabled) return null;
  switch (block.type) {
    case 'hero':
      return (
        <section className={`${panel} py-12`}>
          <h2 className="text-3xl font-bold tracking-tight">{block.heading}</h2>
          <p className="my-5 max-w-2xl text-lg text-[var(--color-muted)] whitespace-pre-line">
            {block.text}
          </p>
          {block.action && <Action action={block.action} locale={locale} />}
        </section>
      );
    case 'markdown':
      return (
        <section>
          <>
            {block.heading && <h2 className="text-2xl font-semibold mb-5">{block.heading}</h2>}
            <div
              className="site-prose"
              dangerouslySetInnerHTML={{
                __html: renderMarkdown(block.markdown, locale, `block-${block.id}`).html,
              }}
            />
          </>
        </section>
      );
    case 'features':
      return (
        <section>
          <h2 className="text-2xl font-semibold mb-5">{block.heading}</h2>
          <div className="grid gap-4 md:grid-cols-3">
            {block.items.map((item, i) => (
              <article className={panel} key={i}>
                <h3 className="font-semibold mb-2">{item.title}</h3>
                <p className="text-[var(--color-muted)] whitespace-pre-line">{item.text}</p>
              </article>
            ))}
          </div>
        </section>
      );
    case 'faq':
      return (
        <section>
          <h2 className="text-2xl font-semibold mb-5">{block.heading}</h2>
          <div className="space-y-3">
            {block.items.map((item, i) => (
              <details key={i} className={panel}>
                <summary className="cursor-pointer font-medium">{item.question}</summary>
                <p className="mt-4 text-[var(--color-muted)] whitespace-pre-line">{item.answer}</p>
              </details>
            ))}
          </div>
        </section>
      );
    case 'cta':
      return (
        <section className={`${panel} text-center`}>
          <h2 className="text-2xl font-semibold">{block.heading}</h2>
          <p className="my-5 text-[var(--color-muted)] whitespace-pre-line">{block.text}</p>
          <Action action={block.action} locale={locale} />
        </section>
      );
    case 'links':
      return (
        <section>
          <h2 className="text-2xl font-semibold mb-5">{block.heading}</h2>
          <div className="flex flex-wrap gap-3">
            {block.items.map((item, i) => (
              <Action key={i} action={item} locale={locale} />
            ))}
          </div>
        </section>
      );
  }
}
export function DocumentView({
  document,
  locale,
  showToc = false,
}: {
  document: SiteDocument;
  locale: string;
  showToc?: boolean;
}) {
  const markdown = renderMarkdown(document.markdown, locale);
  return (
    <div className={showToc ? 'grid gap-10 lg:grid-cols-[minmax(0,1fr)_200px]' : ''}>
      <div className="min-w-0 space-y-10">
        <div className="site-prose" dangerouslySetInnerHTML={{ __html: markdown.html }} />
        {document.blocks.map((block) => (
          <Block key={block.id} block={block} locale={locale} />
        ))}
      </div>
      {showToc && markdown.headings.length > 0 && (
        <aside className="hidden lg:block">
          <nav
            aria-label={locale === 'zh' ? '本页目录' : 'On this page'}
            className="sticky top-24 border-l border-[var(--color-border)] pl-5 text-sm"
          >
            <p className="font-medium mb-4">{locale === 'zh' ? '本页目录' : 'On this page'}</p>
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
