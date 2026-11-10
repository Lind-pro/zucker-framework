import { sitemapPage } from '@/features/content/sitemap';
import { contentPath } from '@/features/content/types';
import { isLocale } from '@/lib/site/locales';
import { buildUrlsetXml, staticSitemapUrls, unavailableResponse, xmlResponse, type SitemapUrl } from '@/lib/site/sitemap';
import { staticSitemapRoutes } from '@/lib/site/sitemap-routes';
import { localizedUrl, siteOrigin } from '@/lib/site/url';
export const dynamic = 'force-dynamic';
export async function GET(_request: Request, { params }: { params: Promise<{ file: string }> }) {
  const { file } = await params;
  if (!/^(?:0|[1-9][0-9]{0,5})\.xml$/.test(file) || Number(file.slice(0, -4)) > 100000)
    return new Response('Not found', { status: 404 });
  const page = Number(file.slice(0, -4));
  try {
    const origin = siteOrigin();
    if (page === 0) return xmlResponse(buildUrlsetXml(staticSitemapUrls(origin, staticSitemapRoutes)));
    const result = await sitemapPage(page);
    if (result.page > Math.max(1, Math.ceil(result.total / result.pageSize)))
      return new Response('Not found', { status: 404 });
    // CMS slugs differ per locale, so entries carry no hreflang alternates here.
    const urls: SitemapUrl[] = result.data.flatMap((row) =>
      isLocale(row.locale)
        ? [
            {
              loc: localizedUrl(
                origin,
                row.locale,
                row.resource === 'category' ? `/blog/category/${row.slug}` : contentPath(row.kind, row.slug),
              ),
              lastmod: new Date(row.updatedAt).toISOString(),
            },
          ]
        : [],
    );
    return xmlResponse(buildUrlsetXml(urls));
  } catch {
    return unavailableResponse();
  }
}
