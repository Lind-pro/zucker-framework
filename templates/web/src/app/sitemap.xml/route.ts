import { sitemapPage } from '@/features/content/sitemap';
import { buildSitemapIndexXml, unavailableResponse, xmlResponse } from '@/lib/site/sitemap';
import { siteOrigin } from '@/lib/site/url';
export const dynamic = 'force-dynamic';
/** Page 0 lists static routes; pages 1..n list CMS entries from the content API. */
export async function GET() {
  try {
    const origin = siteOrigin();
    const first = await sitemapPage(1);
    const count = Math.max(1, Math.ceil(first.total / first.pageSize));
    return xmlResponse(
      buildSitemapIndexXml(Array.from({ length: count + 1 }, (_, index) => `${origin}/sitemaps/${index}.xml`)),
    );
  } catch {
    return unavailableResponse();
  }
}
