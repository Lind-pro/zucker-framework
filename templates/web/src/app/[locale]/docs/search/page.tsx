import { contentCopy } from '@/features/content/copy';
import { publicContent } from '@/features/content/server';
import { localizedHref, type Entry } from '@/features/content/types';
export const metadata = { robots: { index: false, follow: true } };
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ q?: string }>;
}) {
  const { locale } = await params;
  const copy = contentCopy(locale);
  const query = ((await searchParams).q ?? '').trim().slice(0, 100);
  const result = query
    ? await publicContent<{ data: (Entry & { excerpt: string })[] }>('search', { locale, q: query })
    : { data: [] };
  return (
    <section className="mx-auto max-w-4xl px-6 py-14">
      <a className="text-primary-500" href={localizedHref('/docs', locale)}>
        ← {copy.docsTitle}
      </a>
      <h1 className="my-6 text-3xl font-bold">{copy.searchDocs}</h1>
      <form className="mb-8 flex gap-3">
        <input
          aria-label={copy.searchQuery}
          className="content-input"
          name="q"
          defaultValue={query}
          maxLength={100}
          required
        />
        <button className="rounded-lg bg-primary-600 px-5 text-white">{copy.search}</button>
      </form>
      {result.data.length ? (
        <div className="space-y-4">
          {result.data.map((entry) => (
            <a
              key={entry.id}
              className="block rounded-xl border border-[var(--color-border)] p-6"
              href={localizedHref(`/docs/${entry.slug}`, locale)}
            >
              <h2 className="text-xl font-semibold">{entry.title}</h2>
              <p className="mt-3 text-[var(--color-muted)]">{entry.excerpt}</p>
            </a>
          ))}
        </div>
      ) : (
        <p className="text-[var(--color-muted)]">{query ? copy.noSearchMatches : copy.enterQuery}</p>
      )}
    </section>
  );
}
