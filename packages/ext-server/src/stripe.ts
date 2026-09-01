import { createHmac, timingSafeEqual } from 'node:crypto';

// Stripe 签名格式：t=<unix>,v1=<hmac>[,v1=…]；signed_payload = `${t}.${rawBody}`
export function verifyStripeSignature(
  rawBody: Buffer,
  header: string,
  secret: string,
  toleranceSec = 300,
  nowMs = Date.now(),
): boolean {
  const parts = new Map<string, string[]>();
  for (const kv of header.split(',')) {
    const [key, value] = kv.split('=', 2);
    if (!key || !value) {
      continue;
    }
    const list = parts.get(key.trim()) || [];
    list.push(value.trim());
    parts.set(key.trim(), list);
  }
  const timestamp = Number(parts.get('t')?.[0]);
  const candidates = parts.get('v1') || [];
  if (!timestamp || !candidates.length) {
    return false;
  }
  if (Math.abs(nowMs / 1000 - timestamp) > toleranceSec) {
    return false;
  }

  const expected = createHmac('sha256', secret)
    .update(`${timestamp}.`)
    .update(rawBody)
    .digest('hex');
  const expectedBuf = Buffer.from(expected, 'utf8');
  return candidates.some((candidate) => {
    const candidateBuf = Buffer.from(candidate, 'utf8');
    return (
      candidateBuf.length === expectedBuf.length && timingSafeEqual(candidateBuf, expectedBuf)
    );
  });
}
