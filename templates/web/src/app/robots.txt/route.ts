import { sitemapOrigin } from '@/features/content/sitemap';
export const dynamic = 'force-dynamic';
export async function GET() {
  const origin = await sitemapOrigin();
  const privatePaths = [
    'account',
    'billing',
    'dashboard',
    'content/manage',
    'login',
    'register',
    'oauth',
    'forgot-password',
    'reset-password',
    'verify-email',
    'docs/search',
  ];
  const rules = ['User-agent: *', 'Allow: /', 'Disallow: /api/'];
  for (const path of privatePaths)
    for (const prefix of ['', '/zh', '/en']) rules.push(`Disallow: ${prefix}/${path}`);
  rules.push(`Sitemap: ${origin}/sitemap.xml`);
  return new Response(rules.join('\n'), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
