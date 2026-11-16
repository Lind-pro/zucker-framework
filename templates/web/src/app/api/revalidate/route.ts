import { revalidateTag } from 'next/cache';
import { REVALIDATE_MAX_BODY_BYTES, REVALIDATE_MIN_SECRET_LENGTH, ReplayGuard, verifyRevalidation } from '@/features/content/revalidate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const replays = new ReplayGuard();
const headers = { 'Cache-Control': 'no-store' };

/** Content-Length is optional and untrusted: cap actual bytes before decoding/buffering the body. */
async function readBody(request: Request): Promise<string | null> {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let body = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return body + decoder.decode();
      bytes += value.byteLength;
      if (bytes > REVALIDATE_MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        return null;
      }
      body += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * `POST /api/revalidate`: signed cache invalidation from the Server after a content change. This
 * app route takes precedence over the `/api/*` rewrite to the Server. Disabled (404) unless
 * REVALIDATE_SECRET (≥ 32 characters, the same value as the Server's) is configured.
 */
export async function POST(request: Request) {
  const secret = process.env.REVALIDATE_SECRET ?? '';
  if (secret.length < REVALIDATE_MIN_SECRET_LENGTH) return new Response(null, { status: 404, headers });
  const length = Number(request.headers.get('content-length') ?? '0');
  if (length > REVALIDATE_MAX_BODY_BYTES) {
    await request.body?.cancel().catch(() => {});
    return Response.json({ revalidated: false }, { status: 413, headers });
  }
  let rawBody: string | null;
  try {
    rawBody = await readBody(request);
  } catch {
    return Response.json({ revalidated: false }, { status: 400, headers });
  }
  if (rawBody === null) return Response.json({ revalidated: false }, { status: 413, headers });
  const verdict = verifyRevalidation({
    secret,
    timestamp: request.headers.get('x-revalidate-timestamp'),
    signature: request.headers.get('x-revalidate-signature'),
    rawBody,
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
