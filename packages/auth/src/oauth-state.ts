import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  RefreshTokenCookie,
  type RefreshCookieResponse,
  type RefreshTokenCookieOptions,
} from './session/refresh-token-cookie';

export type OAuthStateFailure = 'missing' | 'invalid' | 'mismatch';
export interface OAuthStatePayload<P extends string = string> {
  purpose: 'oauth_state';
  provider: P;
  nonce: string;
}
export interface OAuthStateOptions<P extends string = string> {
  cookie: (provider: P) => RefreshTokenCookieOptions;
  sign: (payload: OAuthStatePayload<P>) => string;
  verify: (state: string) => unknown;
  createError?: (reason: OAuthStateFailure) => Error;
}

/** Signed state bound to a browser's HttpOnly nonce cookie (double submit). */
export class OAuthStateService<P extends string = string> {
  constructor(private readonly options: OAuthStateOptions<P>) {}

  issue(response: RefreshCookieResponse, provider: P): string {
    const nonce = randomBytes(32).toString('base64url');
    new RefreshTokenCookie(this.options.cookie(provider)).issue(response, nonce);
    return this.options.sign({ purpose: 'oauth_state', provider, nonce });
  }

  verify(
    request: { headers: { cookie?: string } },
    response: RefreshCookieResponse,
    provider: P,
    state: string | undefined,
  ): void {
    const cookie = new RefreshTokenCookie(this.options.cookie(provider));
    const nonce = cookie.read(request);
    cookie.clear(response);
    if (!state || !nonce) throw this.error('missing');
    let value: unknown;
    try {
      value = this.options.verify(state);
    } catch {
      throw this.error('invalid');
    }
    if (!value || typeof value !== 'object') throw this.error('mismatch');
    const payload = value as Partial<OAuthStatePayload>;
    if (
      payload.purpose !== 'oauth_state' ||
      payload.provider !== provider ||
      typeof payload.nonce !== 'string'
    )
      throw this.error('mismatch');
    const left = Buffer.from(payload.nonce);
    const right = Buffer.from(nonce);
    if (left.length !== right.length || !timingSafeEqual(left, right)) throw this.error('mismatch');
  }

  private error(reason: OAuthStateFailure): Error {
    return this.options.createError?.(reason) ?? new Error(`OAuth state ${reason}`);
  }
}
