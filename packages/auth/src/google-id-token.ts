import { constants, createPublicKey, timingSafeEqual, verify as verifySignature, type KeyObject } from 'node:crypto';

const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const MAX_TOKEN_BYTES = 16_384;
const MAX_JWKS_BYTES = 131_072;
const REFRESH_COOLDOWN_MS = 30_000;

export type GoogleIdTokenFailure =
  | 'malformed' | 'algorithm' | 'signature' | 'issuer' | 'audience' | 'time'
  | 'nonce' | 'subject' | 'email' | 'email_unverified' | 'key_not_found'
  | 'jwks_unavailable' | 'invalid_jwks';

/** Deliberately excludes the credential, claims, provider body and transport errors. */
export class GoogleIdTokenError extends Error {
  constructor(readonly reason: GoogleIdTokenFailure) {
    super(`Google ID token verification failed: ${reason}`);
    this.name = 'GoogleIdTokenError';
  }
}

export interface GoogleIdTokenVerifierOptions {
  /** Client IDs trusted by this server; never read from a request body. */
  audience: string | readonly string[];
  fetcher?: typeof fetch;
  /** Milliseconds since Unix epoch. */
  now?: () => number;
  /** Defaults to zero; maximum 300 seconds. */
  clockToleranceSeconds?: number;
  /** Default 5 seconds; independent of any caller's cancellation. */
  fetchTimeoutMs?: number;
  /** Upper bound on Google's Cache-Control max-age, default 24 hours. */
  maxCacheAgeSeconds?: number;
}

export interface VerifiedGoogleIdentity {
  provider: 'google';
  /** Google's immutable sub, not the email address. */
  subject: string;
  email: string;
  emailVerified: true;
  displayName?: string;
  avatarUrl?: string;
  hostedDomain?: string;
  issuedAt: number;
  expiresAt: number;
}

export interface GoogleIdTokenExpectation {
  /** Load from a server-issued, browser-bound intent. Never trust a nonce supplied with the credential. */
  nonce: string;
  signal?: AbortSignal;
}

type JsonRecord = Record<string, unknown>;
const object = (value: unknown): JsonRecord | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : undefined;
const nonempty = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max;
const fail = (reason: GoogleIdTokenFailure): never => { throw new GoogleIdTokenError(reason); };

function base64url(value: string): Buffer {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) return fail('malformed');
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value) return fail('malformed');
  return bytes;
}
function parseJson(value: string): JsonRecord {
  let decoded: unknown;
  try { decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(base64url(value))); }
  catch { return fail('malformed'); }
  return object(decoded) ?? fail('malformed');
}
function positiveOption(value: number, maximum: number, name: string, minimum = 0): number {
  if (!Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`Invalid ${name}`);
  return value;
}
function sameSecret(left: string, right: string): boolean {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function waitFor<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const aborted = () => { signal.removeEventListener('abort', aborted); reject(signal.reason); };
    signal.addEventListener('abort', aborted, { once: true });
    pending.then(value => { signal.removeEventListener('abort', aborted); resolve(value); },
      error => { signal.removeEventListener('abort', aborted); reject(error); });
  });
}

/** Server-only One Tap verifier. It verifies identity, not admission, account linking or nonce consumption. */
export class GoogleIdTokenVerifier {
  private readonly audiences: ReadonlySet<string>;
  private readonly now: () => number;
  private readonly tolerance: number;
  private readonly timeout: number;
  private readonly maxAge: number;
  private cache?: { keys: Map<string, KeyObject>; expiresAt: number };
  private pending?: Promise<void>;
  private lastForcedRefresh = -Infinity;
  private failedAt = -Infinity;
  private lastFailure?: GoogleIdTokenError;

  constructor(private readonly options: GoogleIdTokenVerifierOptions) {
    const audiences = typeof options.audience === 'string' ? [options.audience] : options.audience;
    if (!Array.isArray(audiences) || !audiences.length || audiences.some(value => !nonempty(value, 1024))) {
      throw new Error('Google audience must contain trusted client IDs');
    }
    this.audiences = new Set(audiences);
    this.now = options.now ?? Date.now;
    this.tolerance = positiveOption(options.clockToleranceSeconds ?? 0, 300, 'clock tolerance');
    this.timeout = positiveOption(options.fetchTimeoutMs ?? 5000, 30_000, 'JWKS timeout', 1);
    this.maxAge = positiveOption(options.maxCacheAgeSeconds ?? 86400, 86400, 'JWKS cache age');
  }

  async verify(credential: string, expectation: GoogleIdTokenExpectation): Promise<VerifiedGoogleIdentity> {
    expectation.signal?.throwIfAborted();
    if (!nonempty(credential, MAX_TOKEN_BYTES)) return fail('malformed');
    if (!nonempty(expectation.nonce, 1024)) return fail('nonce');
    const segments = credential.split('.');
    if (segments.length !== 3) return fail('malformed');
    const [encodedHeader, encodedClaims, encodedSignature] = segments as [string, string, string];
    const header = parseJson(encodedHeader), claims = parseJson(encodedClaims);
    if (header.alg !== 'RS256' || header.crit !== undefined || header.b64 !== undefined) return fail('algorithm');
    if (!nonempty(header.kid, 256)) return fail('malformed');
    const signature = base64url(encodedSignature);
    const key = await waitFor(this.key(header.kid), expectation.signal);
    expectation.signal?.throwIfAborted();
    let valid = false;
    try {
      valid = verifySignature('RSA-SHA256', Buffer.from(`${encodedHeader}.${encodedClaims}`),
        { key, padding: constants.RSA_PKCS1_PADDING }, signature);
    } catch { return fail('signature'); }
    if (!valid) return fail('signature');
    if (claims.iss !== 'https://accounts.google.com' && claims.iss !== 'accounts.google.com') return fail('issuer');
    const audiences = typeof claims.aud === 'string' ? [claims.aud] : claims.aud;
    if (!Array.isArray(audiences) || !audiences.length || audiences.some(a => !nonempty(a, 1024)) ||
      !audiences.some(a => this.audiences.has(a))) return fail('audience');
    if ((audiences.length > 1 && claims.azp === undefined) ||
      (claims.azp !== undefined && (typeof claims.azp !== 'string' || !this.audiences.has(claims.azp)))) return fail('audience');
    const now = this.now() / 1000;
    if (!Number.isFinite(now) || typeof claims.exp !== 'number' || !Number.isSafeInteger(claims.exp) ||
      typeof claims.iat !== 'number' || !Number.isSafeInteger(claims.iat) ||
      claims.iat <= 0 || claims.exp <= claims.iat || claims.exp <= now - this.tolerance || claims.iat > now + this.tolerance ||
      (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || !Number.isSafeInteger(claims.nbf) || claims.nbf > now + this.tolerance))) return fail('time');
    if (!nonempty(claims.nonce, 1024) || !sameSecret(claims.nonce, expectation.nonce)) return fail('nonce');
    if (!nonempty(claims.sub, 255) || !/^[\x21-\x7e]+$/.test(claims.sub)) return fail('subject');
    if (!nonempty(claims.email, 320) || !/^[^\s@]+@[^\s@]+$/.test(claims.email)) return fail('email');
    if (claims.email_verified !== true) return fail('email_unverified');
    return {
      provider: 'google', subject: claims.sub, email: claims.email, emailVerified: true,
      displayName: nonempty(claims.name, 1024) ? claims.name : undefined,
      avatarUrl: nonempty(claims.picture, 4096) ? claims.picture : undefined,
      hostedDomain: nonempty(claims.hd, 255) ? claims.hd : undefined,
      issuedAt: claims.iat, expiresAt: claims.exp,
    };
  }

  private async key(kid: string): Promise<KeyObject> {
    if (!this.cache || this.cache.expiresAt <= this.now()) {
      await this.refresh();
    } else if (!this.cache.keys.has(kid)) {
      if (this.pending) await this.pending;
      else if (this.now() - this.lastForcedRefresh >= REFRESH_COOLDOWN_MS) {
        this.lastForcedRefresh = this.now();
        await this.refresh();
      }
    }
    return this.cache?.keys.get(kid) ?? fail('key_not_found');
  }

  private refresh(): Promise<void> {
    if (this.pending) return this.pending;
    if (this.lastFailure && this.now() - this.failedAt < REFRESH_COOLDOWN_MS) return Promise.reject(this.lastFailure);
    this.pending = this.loadKeys().catch((error: unknown) => {
      // Transport causes can include arbitrary provider text; expose only our bounded reason.
      this.lastFailure = error instanceof GoogleIdTokenError ? error : new GoogleIdTokenError('jwks_unavailable');
      this.failedAt = this.now();
      throw this.lastFailure;
    }).finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async loadKeys(): Promise<void> {
    const response = await (this.options.fetcher ?? fetch)(JWKS_URL, {
      method: 'GET', headers: { Accept: 'application/json' }, redirect: 'error',
      signal: AbortSignal.timeout(this.timeout),
    });
    if (!response.ok || Number(response.headers.get('content-length') || 0) > MAX_JWKS_BYTES) return fail('jwks_unavailable');
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_JWKS_BYTES) return fail('invalid_jwks');
    let body: JsonRecord | undefined;
    try { body = object(JSON.parse(text)); } catch { return fail('invalid_jwks'); }
    if (!Array.isArray(body?.keys) || body.keys.length > 32) return fail('invalid_jwks');
    const keys = new Map<string, KeyObject>();
    for (const entry of body.keys) {
      const jwk = object(entry);
      if (!jwk || jwk.kty !== 'RSA' || (jwk.alg !== undefined && jwk.alg !== 'RS256') ||
        (jwk.use !== undefined && jwk.use !== 'sig') ||
        (jwk.key_ops !== undefined && (!Array.isArray(jwk.key_ops) || !jwk.key_ops.includes('verify')))) continue;
      if (!nonempty(jwk.kid, 256) || !nonempty(jwk.n, 4096) || !nonempty(jwk.e, 16) || keys.has(jwk.kid)) return fail('invalid_jwks');
      let key: KeyObject;
      try {
        base64url(jwk.n); base64url(jwk.e);
        key = createPublicKey({ format: 'jwk', key: { kty: 'RSA', n: jwk.n, e: jwk.e } });
      } catch { return fail('invalid_jwks'); }
      if (key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) return fail('invalid_jwks');
      keys.set(jwk.kid, key);
    }
    if (!keys.size) return fail('invalid_jwks');
    const cacheControl = response.headers.get('cache-control') || '';
    const maxAge = /(?:^|,)\s*max-age\s*=\s*"?(\d+)"?/i.exec(cacheControl)?.[1];
    const ageHeader = response.headers.get('age') || '0';
    const age = /^\d+$/.test(ageHeader) ? Number(ageHeader) : 0;
    const seconds = /(?:^|,)\s*(?:no-cache|no-store)(?:\s|,|$)/i.test(cacheControl) ? 0
      : Math.max(0, Math.min(Number(maxAge ?? 300), this.maxAge) - age);
    this.cache = { keys, expiresAt: this.now() + seconds * 1000 };
    this.lastFailure = undefined;
  }
}
