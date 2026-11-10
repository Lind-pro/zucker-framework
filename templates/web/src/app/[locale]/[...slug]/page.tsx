import { permanentRedirect } from 'next/navigation';
import { ArticlePage } from '@/features/content/PublicPages';
import { entryMetadata } from '@/features/content/server';
import { HOME_PAGE_SLUG, localizedHref } from '@/features/content/types';
type Props = { params: Promise<{ locale: string; slug: string[] }> };
export async function generateMetadata({ params }: Props) {
  const { locale, slug } = await params;
  return entryMetadata('page', locale, slug.join('/'));
}
export default async function Page({ params }: Props) {
  const { locale, slug } = await params;
  const path = slug.join('/');
  // The home page lives at the site root only.
  if (path === HOME_PAGE_SLUG) permanentRedirect(localizedHref('/', locale));
  return <ArticlePage kind="page" locale={locale} slug={path} />;
}
