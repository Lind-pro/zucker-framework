import { revalidateTag } from 'next/cache';
import { REVALIDATE_MIN_SECRET_LENGTH, ReplayGuard, verifyRevalidation } from '@/features/content/revalidate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const replays = new ReplayGuard();
const headers = { 'Cache-Control': 'no-store' };

/**
 * `POST /api/revalidate`: signed cache invalidation from the Server after a content change. This
 * app route takes precedence over the `/api/*` rewrite to the Server. Disabled (404) unless
 * REVALIDATE_SECRET (≥ 32 characters, the same value as the Server's) is configured.
 */
export async function POST(request: Request) {
  const secret = process.env.REVALIDATE_SECRET ?? '';
  if (secret.length < REVALIDATE_MIN_SECRET_LENGTH) return new Response(null, { status: 404, headers });
  const length = Number(request.headers.get('content-length') ?? '0');
  if (length > 16 * 1024) return Response.json({ revalidated: false }, { status: 413, headers });
  const verdict = verifyRevalidation({
    secret,
    timestamp: request.headers.get('x-revalidate-timestamp'),
    signature: request.headers.get('x-revalidate-signature'),
    rawBody: await request.text(),
  });
  if (!verdict.ok) {
    // Redacted: the reason only, never the body, signature or secret.
    console.warn(`Rejected revalidate request: ${verdict.reason}`);
    return Response.json({ revalidated: false }, { status: verdict.status, headers });
  }
  if (!replays.accept(request.headers.get('x-revalidate-signature')!.trim()))
    return Response.json({ revalidated: false }, { status: 401, headers });
  // Expire immediately so the next request renders fresh content (no stale-while-revalidate).
  for (const tag of verdict.tags) revalidateTag(tag, { expire: 0 });
  return Response.json({ revalidated: true, tags: verdict.tags.length }, { headers });
}
