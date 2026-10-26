import { sitemapOrigin, sitemapPage, xml, xmlResponse } from '@/features/content/sitemap';
export const dynamic = 'force-dynamic';
export async function GET() {
  try {
    const [first, origin] = await Promise.all([sitemapPage(1), sitemapOrigin()]);
    const count = Math.max(1, Math.ceil(first.total / first.pageSize));
    return xmlResponse(
      `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${Array.from({ length: count }, (_, index) => `<sitemap><loc>${xml(`${origin}/sitemaps/${index + 1}.xml`)}</loc></sitemap>`).join('')}</sitemapindex>`,
    );
  } catch {
    return new Response('Sitemap temporarily unavailable', {
      status: 503,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
}
