import { ArticlePage, ContentListing } from '@/features/content/PublicPages';
import { entryMetadata, listingMetadata } from '@/features/content/server';
type Props = {
  params: Promise<{ locale: string; slug?: string[] }>;
  searchParams: Promise<{ page?: string }>;
};
export async function generateMetadata({ params, searchParams }: Props) {
  const { locale, slug } = await params;
  return slug?.length
    ? entryMetadata('doc', locale, slug.join('/'))
    : listingMetadata('doc', locale, (await searchParams).page);
}
export default async function Page({ params, searchParams }: Props) {
  const { locale, slug } = await params;
  const { page } = await searchParams;
  return slug?.length ? (
    <ArticlePage kind="doc" locale={locale} slug={slug.join('/')} />
  ) : (
    <ContentListing kind="doc" locale={locale} page={page} />
  );
}
