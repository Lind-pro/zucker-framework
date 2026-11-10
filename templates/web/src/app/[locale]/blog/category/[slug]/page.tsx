import { ContentListing } from '@/features/content/PublicPages';
import { contentCopy } from '@/features/content/copy';
import { pagedPath, readEntries, readSiteSettings, routeLocale } from '@/features/content/server';
import { buildMetadata } from '@/lib/site/metadata';
type Props = {
  params: Promise<{ locale: string; slug: string }>;
  searchParams: Promise<{ page?: string }>;
};
export async function generateMetadata({ params, searchParams }: Props) {
  const { locale, slug } = await params;
  const { page } = await searchParams;
  const [result, site] = await Promise.all([readEntries('post', locale, '1', slug), readSiteSettings(locale)]);
  return buildMetadata({
    locale: routeLocale(locale),
    path: pagedPath(`/blog/category/${slug}`, page),
    title: result.category?.title || contentCopy(locale).blogTitle,
    description: result.category?.description || undefined,
    // Category slugs differ per locale.
    alternateLocales: [routeLocale(locale)],
    siteName: site.name,
  });
}
export default async function Page({ params, searchParams }: Props) {
  const { locale, slug } = await params;
  const { page } = await searchParams;
  return <ContentListing kind="post" locale={locale} category={slug} page={page} />;
}
