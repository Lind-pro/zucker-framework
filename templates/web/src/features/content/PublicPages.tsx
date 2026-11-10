import { landingSlots } from '@/features/landing/slots';
import { contentCopy } from './copy';
import { publicContent, readEntries, readEntry } from './server';
import { contentPath, localizedHref, type Category, type ContentKind } from './types';
import { DocumentView } from './DocumentView';

const listingPath = { post: '/blog', doc: '/docs', log: '/changelog' } as const;

function formatDate(value: string, locale: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(locale, { timeZone: 'UTC' });
}

export async function ArticlePage({ kind, locale, slug }: { kind: ContentKind; locale: string; slug: string }) {
  const entry = await readEntry(kind, locale, slug);
  const copy = contentCopy(locale);
  const back = kind === 'post' ? copy.blogTitle : kind === 'doc' ? copy.docsShort : copy.changelogTitle;
  return (
    <article className="mx-auto max-w-6xl px-6 py-12 md:py-16">
      <header className="max-w-3xl mb-10">
        {kind !== 'page' && (
          <a className="text-sm text-primary-500" href={localizedHref(listingPath[kind], locale)}>
            ← {back}
          </a>
        )}
        <h1 className="mt-4 text-4xl font-bold tracking-tight md:text-5xl">{entry.title}</h1>
        {entry.description && <p className="mt-5 text-xl text-[var(--color-muted)]">{entry.description}</p>}
        {(kind === 'post' || kind === 'log') && (
          <div className="mt-5 flex flex-wrap gap-3 text-sm text-[var(--color-muted)]">
            {kind === 'post' && entry.authorName && <span>{entry.authorName}</span>}
            <time dateTime={entry.publishedAt}>{formatDate(entry.publishedAt, locale)}</time>
            {entry.categories.map((category) => (
              <a
                key={category.id}
                href={localizedHref(`/blog/category/${category.slug}`, locale)}
                className="text-primary-500"
              >
                {category.title}
              </a>
            ))}
          </div>
        )}
      </header>
      <DocumentView
        document={entry.document}
        locale={locale}
        showToc={kind === 'doc'}
        slots={kind === 'page' ? landingSlots : undefined}
      />
    </article>
  );
}

function Pagination({
  locale,
  href,
  page,
  pageSize,
  total,
}: {
  locale: string;
  href: string;
  page: number;
  pageSize: number;
  total: number;
}) {
  const copy = contentCopy(locale);
  return (
    <nav aria-label={copy.pagination} className="mt-8 flex justify-between text-sm text-primary-500">
      <span>
        {page > 1 && (
          <a href={localizedHref(page === 2 ? href : `${href}?page=${page - 1}`, locale)}>← {copy.previous}</a>
        )}
      </span>
      {page * pageSize < total && (
        <a href={localizedHref(`${href}?page=${page + 1}`, locale)}>
          {copy.next} →
        </a>
      )}
    </nav>
  );
}

export async function ContentListing({
  kind,
  locale,
  page = '1',
  category,
}: {
  kind: 'post' | 'doc';
  locale: string;
  page?: string;
  category?: string;
}) {
  const [entries, categories] = await Promise.all([
    readEntries(kind, locale, page, category),
    kind === 'post' ? publicContent<Category[]>('categories', { locale }) : Promise.resolve([]),
  ]);
  const copy = contentCopy(locale);
  const title = entries.category?.title ?? (kind === 'post' ? copy.blogTitle : copy.docsTitle);
  const href = `${listingPath[kind]}${category ? `/category/${category}` : ''}`;
  return (
    <section className="mx-auto max-w-6xl px-6 py-12 md:py-16">
      <div className="mb-10">
        <p className="text-sm font-medium text-primary-500">
          {kind === 'post' ? copy.blogEyebrow : copy.docsEyebrow}
        </p>
        <h1 className="mt-3 text-4xl font-bold tracking-tight">{title}</h1>
        {entries.category?.description && (
          <p className="mt-4 text-lg text-[var(--color-muted)]">{entries.category.description}</p>
        )}
      </div>
      {kind === 'doc' && (
        <form action={localizedHref('/docs/search', locale)} className="mb-8 flex max-w-xl gap-3">
          <label className="sr-only" htmlFor="docs-query">
            {copy.searchDocs}
          </label>
          <input
            id="docs-query"
            name="q"
            maxLength={100}
            required
            placeholder={copy.searchPlaceholder}
            className="content-input"
          />
          <button className="rounded-lg bg-primary-600 px-5 text-white">{copy.search}</button>
        </form>
      )}
      {categories.length > 0 && (
        <nav aria-label={copy.blogCategories} className="mb-8 flex flex-wrap gap-3">
          <a
            href={localizedHref('/blog', locale)}
            className="rounded-full border border-[var(--color-border)] px-4 py-2 text-sm"
          >
            {copy.all}
          </a>
          {categories.map((item) => (
            <a
              className={`rounded-full border px-4 py-2 text-sm ${category === item.slug ? 'border-primary-500 text-primary-500' : 'border-[var(--color-border)]'}`}
              href={localizedHref(`/blog/category/${item.slug}`, locale)}
              key={item.id}
            >
              {item.title}
            </a>
          ))}
        </nav>
      )}
      {entries.data.length ? (
        <div className="grid gap-5 md:grid-cols-2">
          {entries.data.map((entry) => (
            <a
              className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-card)] p-6 transition-colors hover:border-primary-500"
              href={localizedHref(contentPath(kind, entry.slug), locale)}
              key={entry.id}
            >
              <h2 className="text-xl font-semibold">{entry.title}</h2>
              <p className="mt-3 text-[var(--color-muted)]">{entry.description}</p>
              {kind === 'post' && (
                <p className="mt-6 text-xs text-[var(--color-muted)]">
                  {entry.authorName}
                  {entry.authorName && ' · '}
                  {formatDate(entry.publishedAt, locale)}
                </p>
              )}
            </a>
          ))}
        </div>
      ) : (
        <p className="rounded-xl border border-dashed border-[var(--color-border)] p-10 text-center text-[var(--color-muted)]">
          {copy.noContent}
        </p>
      )}
      <Pagination locale={locale} href={href} page={entries.page} pageSize={entries.pageSize} total={entries.total} />
    </section>
  );
}

/** `/changelog`: releases (`log` entries) newest first, each with its full document. */
export async function ChangelogListing({ locale, page = '1' }: { locale: string; page?: string }) {
  const entries = await readEntries('log', locale, page, undefined, 'document');
  const copy = contentCopy(locale);
  return (
    <section className="mx-auto max-w-4xl px-6 py-12 md:py-16">
      <div className="mb-12">
        <p className="text-sm font-medium text-primary-500">{copy.changelogEyebrow}</p>
        <h1 className="mt-3 text-4xl font-bold tracking-tight">{copy.changelogTitle}</h1>
        <p className="mt-4 text-lg text-[var(--color-muted)]">{copy.changelogDescription}</p>
      </div>
      {entries.data.length ? (
        <ol className="space-y-14">
          {entries.data.map((entry) => (
            <li key={entry.id} className="grid gap-4 md:grid-cols-[160px_minmax(0,1fr)]">
              <time dateTime={entry.publishedAt} className="text-sm text-[var(--color-muted)] md:pt-1.5">
                {formatDate(entry.publishedAt, locale)}
              </time>
              <article id={entry.slug} className="min-w-0">
                <h2 className="text-2xl font-semibold tracking-tight">
                  <a href={localizedHref(contentPath('log', entry.slug), locale)} className="hover:text-primary-500">
                    {entry.title}
                  </a>
                </h2>
                {entry.description && <p className="mt-2 text-[var(--color-muted)]">{entry.description}</p>}
                {entry.document && (
                  <div className="mt-6">
                    <DocumentView document={entry.document} locale={locale} anchorPrefix={`log-${entry.slug}`} />
                  </div>
                )}
              </article>
            </li>
          ))}
        </ol>
      ) : (
        <p className="rounded-xl border border-dashed border-[var(--color-border)] p-10 text-center text-[var(--color-muted)]">
          {copy.noContent}
        </p>
      )}
      <Pagination locale={locale} href="/changelog" page={entries.page} pageSize={entries.pageSize} total={entries.total} />
    </section>
  );
}
