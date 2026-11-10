import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Receiver side of the Server's signed revalidate notification
 * (templates/server/src/content/content-revalidate.ts):
 *   body    `{"tags":[...]}`, 1..32 tags matching REVALIDATE_TAG_PATTERN
 *   header  `x-revalidate-timestamp`: Unix seconds, accepted within ±300 s of this host's clock
 *   header  `x-revalidate-signature`: `v1=` + hex HMAC-SHA256(secret, `${timestamp}.${rawBody}`)
 * The signature is checked over the exact raw bytes, in constant time, before the body is parsed.
 * Relative imports only: node tests load this module directly.
 */
export const REVALIDATE_WINDOW_SECONDS = 300;
export const REVALIDATE_MAX_TAGS = 32;
export const REVALIDATE_MAX_BODY_BYTES = 16 * 1024;
export const REVALIDATE_MIN_SECRET_LENGTH = 32;
export const REVALIDATE_TAG_PATTERN = /^[a-z0-9][a-z0-9:/_-]{0,255}$/;

export type RevalidateVerdict =
  | { ok: true; tags: string[] }
  | { ok: false; status: 400 | 401 | 413; reason: string };

export interface RevalidateRequest {
  secret: string;
  timestamp: string | null;
  signature: string | null;
  rawBody: string;
  /** Milliseconds; injectable for tests. */
  now?: number;
}

export function signRevalidation(secret: string, timestamp: number | string, body: string): string {
  return `v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

export function verifyRevalidation(input: RevalidateRequest): RevalidateVerdict {
  if (Buffer.byteLength(input.rawBody, 'utf8') > REVALIDATE_MAX_BODY_BYTES)
    return { ok: false, status: 413, reason: 'body too large' };
  const timestamp = input.timestamp?.trim() ?? '';
  if (!/^[0-9]{1,12}$/.test(timestamp)) return { ok: false, status: 401, reason: 'missing or malformed timestamp' };
  const nowSeconds = Math.floor((input.now ?? Date.now()) / 1000);
  if (Math.abs(nowSeconds - Number(timestamp)) > REVALIDATE_WINDOW_SECONDS)
    return { ok: false, status: 401, reason: 'timestamp outside the accepted window' };
  const signature = input.signature?.trim() ?? '';
  if (!/^v1=[0-9a-f]{64}$/.test(signature)) return { ok: false, status: 401, reason: 'missing or malformed signature' };
  const expected = Buffer.from(signRevalidation(input.secret, timestamp, input.rawBody), 'utf8');
  const received = Buffer.from(signature, 'utf8');
  // Both are exactly 67 ASCII bytes here (format checked above), so the comparison never throws.
  if (expected.length !== received.length || !timingSafeEqual(expected, received))
    return { ok: false, status: 401, reason: 'signature mismatch' };
  let body: unknown;
  try {
    body = JSON.parse(input.rawBody);
  } catch {
    return { ok: false, status: 400, reason: 'body is not JSON' };
  }
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).join() !== 'tags')
    return { ok: false, status: 400, reason: 'body must be {"tags":[...]}' };
  const tags = (body as { tags: unknown }).tags;
  if (
    !Array.isArray(tags) ||
    tags.length < 1 ||
    tags.length > REVALIDATE_MAX_TAGS ||
    !tags.every((tag) => typeof tag === 'string' && REVALIDATE_TAG_PATTERN.test(tag))
  )
    return { ok: false, status: 400, reason: 'invalid tags' };
  return { ok: true, tags: [...new Set(tags as string[])] };
}

/**
 * Remembers accepted signatures for the replay window so one captured request cannot be replayed
 * against this process (revalidation is idempotent, so this only limits load). Bounded in size.
 */
export class ReplayGuard {
  private readonly seen = new Map<string, number>();
  private readonly max: number;
  constructor(max = 1000) {
    this.max = max;
  }
  /** True the first time a signature is seen inside the window. */
  accept(signature: string, now = Date.now()): boolean {
    const cutoff = now - 2 * REVALIDATE_WINDOW_SECONDS * 1000;
    for (const [key, at] of this.seen) if (at < cutoff) this.seen.delete(key);
    if (this.seen.has(signature)) return false;
    if (this.seen.size >= this.max) this.seen.delete(this.seen.keys().next().value!);
    this.seen.set(signature, now);
    return true;
  }
}
