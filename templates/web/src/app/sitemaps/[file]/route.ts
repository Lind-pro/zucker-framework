import {
  sitemapOrigin,
  sitemapPage,
  sitemapUrl,
  xml,
  xmlResponse,
} from '@/features/content/sitemap';
export const dynamic = 'force-dynamic';
export async function GET(_request: Request, { params }: { params: Promise<{ file: string }> }) {
  const { file } = await params;
  if (!/^[1-9][0-9]{0,5}\.xml$/.test(file) || Number(file.slice(0, -4)) > 100000)
    return new Response('Not found', { status: 404 });
  try {
    const [result, origin] = await Promise.all([
      sitemapPage(Number(file.slice(0, -4))),
      sitemapOrigin(),
    ]);
    if (result.page > Math.max(1, Math.ceil(result.total / result.pageSize)))
      return new Response('Not found', { status: 404 });
    const staticRoutes =
      result.page === 1
        ? ['zh', 'en']
            .flatMap((locale) =>
              ['', '/pricing', '/blog', '/docs'].map(
                (path) => `<url><loc>${xml(`${origin}/${locale}${path}`)}</loc></url>`,
              ),
            )
            .join('')
        : '';
    return xmlResponse(
      `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${staticRoutes}${result.data.map((row) => `<url><loc>${xml(sitemapUrl(row, origin))}</loc><lastmod>${xml(new Date(row.updatedAt).toISOString())}</lastmod></url>`).join('')}</urlset>`,
    );
  } catch {
    return new Response('Sitemap temporarily unavailable', {
      status: 503,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
}
