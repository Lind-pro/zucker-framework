import { ContentListing } from '@/features/content/PublicPages';
import { listingMetadata } from '@/features/content/server';
export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  const { locale } = await params;
  return listingMetadata('post', locale, (await searchParams).page);
}
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  const { locale } = await params;
  const { page } = await searchParams;
  return <ContentListing kind="post" locale={locale} page={page} />;
}
