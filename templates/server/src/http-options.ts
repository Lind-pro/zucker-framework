/** Shared by the HTTP bootstrap and its actual preflight contract tests. */
export function applicationCorsOptions(env: NodeJS.ProcessEnv) {
  return {
    origin: (env.ACCOUNT_ORIGINS ?? 'http://localhost:4201,http://localhost:4202').split(',').map(value => value.trim()),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-API-Key', 'If-Match'],
    exposedHeaders: ['X-RateLimit-Remaining', 'X-RateLimit-Reset', 'Retry-After'],
  };
}

const PROXY_KEYWORDS = new Set(['loopback', 'linklocal', 'uniquelocal']);
const PROXY_ADDRESS = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9A-Fa-f:]+)(?:\/\d{1,3})?$/;

/**
 * Express `trust proxy` from TRUST_PROXY. Rate limits key on `request.ip`, so behind a proxy it must
 * name the trusted hops; otherwise every client shares the proxy's address (one script can exhaust
 * the login and refresh budgets for everyone). Accepted: a hop count (`1`), Express keywords
 * (`loopback`, `linklocal`, `uniquelocal`) or comma-separated proxy IPs/CIDRs. `true` is refused:
 * it trusts any client-supplied X-Forwarded-For and lets a caller pick its own rate-limit key.
 * Unset means no proxy is trusted (direct exposure).
 */
export function trustProxySetting(value: string | undefined): number | string | string[] | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  if (/^\d+$/.test(text)) {
    const hops = Number(text);
    if (hops < 1 || hops > 10) throw new Error('TRUST_PROXY hop count must be from 1 to 10');
    return hops;
  }
  if (/^(true|false|\*)$/i.test(text)) throw new Error('TRUST_PROXY must name hops or proxy addresses, not true/false/*');
  const entries = text.split(',').map(entry => entry.trim()).filter(Boolean);
  if (!entries.length || entries.some(entry => !PROXY_KEYWORDS.has(entry) && !PROXY_ADDRESS.test(entry)))
    throw new Error('TRUST_PROXY must be a hop count, loopback/linklocal/uniquelocal or proxy IPs/CIDRs');
  return entries.length === 1 ? entries[0] : entries;
}
