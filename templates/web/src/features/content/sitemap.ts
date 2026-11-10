import { staticSitemapRoutes } from '@/lib/site/sitemap-routes';
import { publicContent } from './server';
import { contentPath, type ContentKind } from './types';
export interface SitemapRow {
  resource: 'entry' | 'category';
  kind: ContentKind;
  locale: string;
  slug: string;
  updatedAt: string;
}
export interface SitemapPage {
  data: SitemapRow[];
  total: number;
  page: number;
  pageSize: number;
}
/**
 * One page of CMS sitemap rows. Rows whose public path is already a static route (the `home` page
 * is served at `/`) are dropped: page 0 lists those with hreflang alternates. `total`/`pageSize`
 * stay the Server's so page numbering is unchanged.
 */
export async function sitemapPage(page: number): Promise<SitemapPage> {
  const result = await publicContent<SitemapPage>('sitemap', { page: String(page) });
  const fixed = new Set(staticSitemapRoutes);
  return {
    ...result,
    data: result.data.filter((row) => row.resource !== 'entry' || !fixed.has(contentPath(row.kind, row.slug))),
  };
}
