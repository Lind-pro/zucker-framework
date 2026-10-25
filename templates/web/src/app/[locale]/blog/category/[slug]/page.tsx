import { ContentListing } from '@/features/content/PublicPages';
import { publicContent, readSiteSettings } from '@/features/content/server';
import type { EntryPage } from '@/features/content/types';
type Props = {
  params: Promise<{ locale: string; slug: string }>;
  searchParams: Promise<{ page?: string }>;
};
export async function generateMetadata({ params }: Props) {
  const { locale, slug } = await params;
  const [result, site] = await Promise.all([
    publicContent<EntryPage>('entries', { kind: 'post', locale, category: slug }),
    readSiteSettings(locale),
  ]);
  return {
    title: result.category?.title,
    description: result.category?.description,
    alternates: { canonical: `${site.siteUrl}/${locale}/blog/category/${slug}` },
  };
}
export default async function Page({ params, searchParams }: Props) {
  const { locale, slug } = await params;
  const { page } = await searchParams;
  return <ContentListing kind="post" locale={locale} category={slug} page={page} />;
}
