import { ROBOTS_DISALLOWED_PREFIXES } from '@/lib/site/cache-policy';
import { LOCALES } from '@/lib/site/locales';
import { siteOrigin } from '@/lib/site/url';
export const dynamic = 'force-dynamic';
export async function GET() {
  const rules = ['User-agent: *', 'Allow: /', 'Disallow: /api/'];
  for (const path of ROBOTS_DISALLOWED_PREFIXES)
    for (const prefix of ['', ...LOCALES.map((locale) => `/${locale}`)]) rules.push(`Disallow: ${prefix}${path}`);
  rules.push(`Sitemap: ${siteOrigin()}/sitemap.xml`);
  return new Response(rules.join('\n'), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
