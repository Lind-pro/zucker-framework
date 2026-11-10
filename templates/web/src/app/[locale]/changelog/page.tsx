import { ChangelogListing } from '@/features/content/PublicPages';
import { listingMetadata } from '@/features/content/server';

type Props = { params: Promise<{ locale: string }>; searchParams: Promise<{ page?: string }> };

export async function generateMetadata({ params, searchParams }: Props) {
  const { locale } = await params;
  return listingMetadata('log', locale, (await searchParams).page);
}
export default async function Page({ params, searchParams }: Props) {
  const { locale } = await params;
  const { page } = await searchParams;
  return <ChangelogListing locale={locale} page={page} />;
}
