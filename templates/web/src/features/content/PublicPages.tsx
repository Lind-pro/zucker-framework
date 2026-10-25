import { publicContent, readEntry } from './server';
import {
  contentPath,
  localizedHref,
  type Category,
  type ContentKind,
  type EntryPage,
} from './types';
import { DocumentView } from './DocumentView';

export async function ArticlePage({
  kind,
  locale,
  slug,
}: {
  kind: ContentKind;
  locale: string;
  slug: string;
}) {
  const entry = await readEntry(kind, locale, slug);
  return (
    <article className="mx-auto max-w-6xl px-6 py-12 md:py-16">
      <header className="max-w-3xl mb-10">
        {kind !== 'page' && (
          <a
            className="text-sm text-primary-500"
            href={`/${locale}/${kind === 'post' ? 'blog' : 'docs'}`}
          >
            ←{' '}
            {kind === 'post'
              ? locale === 'zh'
                ? '博客'
                : 'Blog'
              : locale === 'zh'
                ? '文档'
                : 'Documentation'}
          </a>
        )}
        <h1 className="mt-4 text-4xl font-bold tracking-tight md:text-5xl">{entry.title}</h1>
        <p className="mt-5 text-xl text-[var(--color-muted)]">{entry.description}</p>
        {kind === 'post' && (
          <div className="mt-5 flex flex-wrap gap-3 text-sm text-[var(--color-muted)]">
            {entry.authorName && <span>{entry.authorName}</span>}
            <time dateTime={entry.publishedAt}>
              {new Date(entry.publishedAt).toLocaleDateString(locale)}
            </time>
            {entry.categories.map((category) => (
              <a
                key={category.id}
                href={`/${locale}/blog/category/${category.slug}`}
                className="text-primary-500"
              >
                {category.title}
              </a>
            ))}
          </div>
        )}
      </header>
      <DocumentView document={entry.document} locale={locale} showToc={kind === 'doc'} />
    </article>
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
    publicContent<EntryPage>('entries', { kind, locale, page, ...(category ? { category } : {}) }),
    kind === 'post' ? publicContent<Category[]>('categories', { locale }) : Promise.resolve([]),
  ]);
  const title =
    entries.category?.title ??
    (kind === 'post'
      ? locale === 'zh'
        ? '博客'
        : 'Blog'
      : locale === 'zh'
        ? '文档中心'
        : 'Documentation');
  const href = `/${locale}/${kind === 'post' ? 'blog' : 'docs'}${category ? `/category/${category}` : ''}`;
  return (
    <section className="mx-auto max-w-6xl px-6 py-12 md:py-16">
      <div className="mb-10">
        <p className="text-sm font-medium text-primary-500">
          {kind === 'post'
            ? locale === 'zh'
              ? '最新动态与经验'
              : 'Ideas and updates'
            : locale === 'zh'
              ? '指南与参考'
              : 'Guides and reference'}
        </p>
        <h1 className="mt-3 text-4xl font-bold tracking-tight">{title}</h1>
        {entries.category?.description && (
          <p className="mt-4 text-lg text-[var(--color-muted)]">{entries.category.description}</p>
        )}
      </div>
      {kind === 'doc' && (
        <form action={`/${locale}/docs/search`} className="mb-8 flex max-w-xl gap-3">
          <label className="sr-only" htmlFor="docs-query">
            {locale === 'zh' ? '搜索文档' : 'Search documentation'}
          </label>
          <input
            id="docs-query"
            name="q"
            maxLength={100}
            required
            placeholder={locale === 'zh' ? '搜索文档…' : 'Search documentation…'}
            className="content-input"
          />
          <button className="rounded-lg bg-primary-600 px-5 text-white">
            {locale === 'zh' ? '搜索' : 'Search'}
          </button>
        </form>
      )}
      {categories.length > 0 && (
        <nav
          aria-label={locale === 'zh' ? '博客分类' : 'Blog categories'}
          className="mb-8 flex flex-wrap gap-3"
        >
          <a
            href={`/${locale}/blog`}
            className="rounded-full border border-[var(--color-border)] px-4 py-2 text-sm"
          >
            {locale === 'zh' ? '全部' : 'All'}
          </a>
          {categories.map((item) => (
            <a
              className={`rounded-full border px-4 py-2 text-sm ${category === item.slug ? 'border-primary-500 text-primary-500' : 'border-[var(--color-border)]'}`}
              href={`/${locale}/blog/category/${item.slug}`}
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
                  {new Date(entry.publishedAt).toLocaleDateString(locale)}
                </p>
              )}
            </a>
          ))}
        </div>
      ) : (
        <p className="rounded-xl border border-dashed border-[var(--color-border)] p-10 text-center text-[var(--color-muted)]">
          {locale === 'zh' ? '暂无已发布内容。' : 'No published content yet.'}
        </p>
      )}
      <nav
        aria-label={locale === 'zh' ? '分页' : 'Pagination'}
        className="mt-8 flex justify-between text-sm text-primary-500"
      >
        <span>
          {entries.page > 1 && (
            <a href={`${href}?page=${entries.page - 1}`}>
              ← {locale === 'zh' ? '上一页' : 'Previous'}
            </a>
          )}
        </span>
        {entries.page * entries.pageSize < entries.total && (
          <a href={`${href}?page=${entries.page + 1}`}>{locale === 'zh' ? '下一页' : 'Next'} →</a>
        )}
      </nav>
    </section>
  );
}
