import {
  REVOCATION_WATERMARK_CLAIM,
  SESSION_TRACKED_CLAIM,
  type AccessTokenClaims,
} from '../services/token.service';

/**
 * Read `sub` / `iat` / `rva` / the session-tracking marker from a JWT whose signature Passport has already verified.
 * Returns an empty object for anything that is not a well-formed compact JWS.
 */
export function readAccessTokenClaims(token: string): AccessTokenClaims {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1] || parts[1].length > 16_384) return {};
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as unknown;
    if (!payload || typeof payload !== 'object') return {};
    const record = payload as Record<string, unknown>;
    const { sub, iat } = record;
    const rva = record[REVOCATION_WATERMARK_CLAIM];
    return {
      ...(typeof rva === 'number' && Number.isFinite(rva) ? { rva } : {}),
      ...(record[SESSION_TRACKED_CLAIM] !== undefined && record[SESSION_TRACKED_CLAIM] !== null && record[SESSION_TRACKED_CLAIM] !== false
        ? { sessionTracked: true }
        : {}),
      ...(typeof sub === 'string' && sub ? { sub } : typeof sub === 'number' ? { sub: String(sub) } : {}),
      ...(typeof iat === 'number' && Number.isFinite(iat) ? { iat } : {}),
    };
  } catch {
    return {};
  }
}

/** Extract the bearer credential from an Authorization header value. */
export function bearerToken(header: unknown): string | undefined {
  if (typeof header !== 'string') return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match?.[1];
}
