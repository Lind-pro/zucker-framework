import { ArticlePage } from '@/features/content/PublicPages';
import { entryMetadata } from '@/features/content/server';
type Props = { params: Promise<{ locale: string; slug: string[] }> };
export async function generateMetadata({ params }: Props) {
  const { locale, slug } = await params;
  return entryMetadata('page', locale, slug.join('/'));
}
export default async function Page({ params }: Props) {
  const { locale, slug } = await params;
  return <ArticlePage kind="page" locale={locale} slug={slug.join('/')} />;
}
