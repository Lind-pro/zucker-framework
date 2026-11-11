import { Inject, Injectable, Optional } from '@nestjs/common';
import { RefreshTokenCookie, type RefreshCookieResponse } from '@zucker-framework/auth';
import { cookieSecure, resolveAccountsOptions, type ResolvedAccountsOptions } from './accounts.options';
import { ACCOUNTS_OPTIONS } from './accounts.tokens';
import type { SessionPair, SignInResult } from './account.service';

/** Public body of an opened session (the refresh token travels only in the HttpOnly cookie). */
export interface AccountSessionBody { userId: string; token: string; expires: number }
export type AccountSignInBody = AccountSessionBody | { twoFactorRequired: true; challenge: string };

/**
 * The HttpOnly refresh cookie of the account host (`cookie` option: name, path, sameSite, secure, domain;
 * max-age = refresh lifetime). Products use it in their own sign-in routes (`AccountService.signIn`) so
 * every login method issues the same cookie and body.
 */
@Injectable()
export class AccountSessionCookie {
  readonly options: ResolvedAccountsOptions;
  private readonly cookie: RefreshTokenCookie;
  constructor(@Optional() @Inject(ACCOUNTS_OPTIONS) options?: ResolvedAccountsOptions) {
    this.options = options ?? resolveAccountsOptions();
    const { name, path, sameSite, domain } = this.options.cookie;
    this.cookie = new RefreshTokenCookie({ name, path, sameSite, ...(domain ? { domain } : {}),
      secure: cookieSecure(this.options), maxAge: this.options.tokens.refreshTtlSeconds * 1000 });
  }
  read(request: { headers: { cookie?: string } }): string | null { return this.cookie.read(request); }
  clear(response: RefreshCookieResponse): void { this.cookie.clear(response); }
  issue(response: RefreshCookieResponse, refreshToken: string): void { this.cookie.issue(response, refreshToken); }
  /** Session pair → cookie + public body. */
  session(pair: SessionPair, response: RefreshCookieResponse): AccountSessionBody {
    this.cookie.issue(response, pair.refreshToken);
    return { userId: pair.userId, token: pair.accessToken, expires: this.options.tokens.accessTtlSeconds * 1000 };
  }
  /** Session → cookie + body; a two-factor challenge is returned as is and sets no cookie. */
  signedIn(result: SignInResult, response: RefreshCookieResponse): AccountSignInBody {
    if (result.twoFactorRequired) return { twoFactorRequired: true, challenge: result.challenge };
    return this.session(result, response);
  }
}
