import { buildAdsTxt } from '@zucker-framework/fe-site';
import { readCurrentSiteIntegrations } from '@/features/site/integrations.server';

export const dynamic = 'force-dynamic';

export async function GET() {
  const headers = { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  let content: string | null;
  try { content = buildAdsTxt((await readCurrentSiteIntegrations()).connections); }
  catch { return new Response('Temporarily unavailable\n', { status: 503, headers }); }
  return new Response(content ?? 'Not Found\n', {
    status: content ? 200 : 404,
    headers,
  });
}
