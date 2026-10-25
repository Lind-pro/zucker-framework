import { publicContent } from '@/features/content/server';
import type { Entry } from '@/features/content/types';
export const metadata = { robots: { index: false, follow: true } };
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ q?: string }>;
}) {
  const { locale } = await params;
  const query = ((await searchParams).q ?? '').trim().slice(0, 100);
  const result = query
    ? await publicContent<{ data: (Entry & { excerpt: string })[] }>('search', { locale, q: query })
    : { data: [] };
  return (
    <section className="mx-auto max-w-4xl px-6 py-14">
      <a className="text-primary-500" href={`/${locale}/docs`}>
        ← {locale === 'zh' ? '文档中心' : 'Documentation'}
      </a>
      <h1 className="my-6 text-3xl font-bold">
        {locale === 'zh' ? '搜索文档' : 'Search documentation'}
      </h1>
      <form className="mb-8 flex gap-3">
        <input
          aria-label={locale === 'zh' ? '关键词' : 'Search query'}
          className="content-input"
          name="q"
          defaultValue={query}
          maxLength={100}
          required
        />
        <button className="rounded-lg bg-primary-600 px-5 text-white">
          {locale === 'zh' ? '搜索' : 'Search'}
        </button>
      </form>
      {result.data.length ? (
        <div className="space-y-4">
          {result.data.map((entry) => (
            <a
              key={entry.id}
              className="block rounded-xl border border-[var(--color-border)] p-6"
              href={`/${locale}/docs/${entry.slug}`}
            >
              <h2 className="text-xl font-semibold">{entry.title}</h2>
              <p className="mt-3 text-[var(--color-muted)]">{entry.excerpt}</p>
            </a>
          ))}
        </div>
      ) : (
        <p className="text-[var(--color-muted)]">
          {query
            ? locale === 'zh'
              ? '没有找到匹配的已发布文档。'
              : 'No matching published documentation.'
            : locale === 'zh'
              ? '输入关键词开始搜索。'
              : 'Enter a query to search.'}
        </p>
      )}
    </section>
  );
}
