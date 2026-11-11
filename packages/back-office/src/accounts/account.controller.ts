import { applyDecorators, Body, Controller, Delete, ForbiddenException, Get, HttpCode, Inject, Optional, Param, Post, Req, Res, UseGuards, type Type } from '@nestjs/common';
import { PermissionService, Permissions, Public, type RefreshCookieResponse } from '@zucker-framework/auth';
import { RateLimit, RateLimitGuard, RateLimiterService, TooManyRequestsException } from '@zucker-framework/rate-limiter';
import { assertAccountOrigin, spendBudgets, type AccountRequest } from './account-security';
import { AccountSessionCookie } from './account-session-cookie';
import { AccountService } from './account.service';
import { accountOrigins, resolveAccountsOptions, type BackOfficeAccountsOptions, type ResolvedAccountsOptions } from './accounts.options';
import { ACCOUNTS_OPTIONS } from './accounts.tokens';
import {
  ACCOUNTS_LIMITER, API_DEFAULT_LIMITER, LOGIN_ACCOUNT_LIMITER, LOGIN_LIMITER, loginAccountKey, SESSION_READ_LIMITER, SESSION_REFRESH_LIMITER,
  SESSION_REFRESH_NETWORK_LIMITER, TWO_FACTOR_LIMITER,
} from './rate-limits';

export interface AccountControllerConfig {
  /** Route switches; omitted values follow the injected options (all on without options). */
  features?: { register?: boolean; magicLink?: boolean; twoFactor?: boolean };
  /** Options used when `ACCOUNTS_OPTIONS` is not provided (narrow compositions that list the controller themselves). */
  fallback?: () => BackOfficeAccountsOptions;
}

/** A route decorator applied only when its feature is on: a disabled feature registers no route. */
const when = (enabled: boolean, ...decorators: Array<MethodDecorator>): MethodDecorator =>
  enabled ? applyDecorators(...decorators) : () => undefined;

/**
 * `/authorize/*` account routes. Built per composition so that disabled features (`register`,
 * `magicLink`, `twoFactor`) have no route at all. Browser mutations need a trusted `Origin`; the refresh
 * token lives only in the HttpOnly cookie.
 */
export function createAccountController(config: AccountControllerConfig = {}): Type<unknown> {
  const register = config.features?.register ?? true;
  const magicLink = config.features?.magicLink ?? true;
  const twoFactor = config.features?.twoFactor ?? true;

  @Controller('authorize')
  @UseGuards(RateLimitGuard)
  @RateLimit(ACCOUNTS_LIMITER)
  @Permissions()
  class AccountController {
    private readonly options: ResolvedAccountsOptions;
    private readonly cookie: AccountSessionCookie;
    private readonly origins: ReadonlySet<string>;
    constructor(readonly accounts: AccountService, private readonly permissions: PermissionService,
      private readonly limiter: RateLimiterService, @Optional() @Inject(ACCOUNTS_OPTIONS) options?: ResolvedAccountsOptions) {
      this.options = options ?? resolveAccountsOptions(config.fallback?.());
      this.cookie = new AccountSessionCookie(this.options);
      this.origins = accountOrigins(this.options);
    }
    private sameOrigin(req: AccountRequest): void { assertAccountOrigin(this.origins, req); }

    /**
     * `{verificationRequired: true}` (ticket or code mailed), or with the account policy's verification off a
     * signed-in session: `{verificationRequired: false, userId, token, expires}` plus the refresh cookie.
     */
    @when(register, Post('register'), Public())
    async register(@Body() body: unknown, @Req() req: AccountRequest, @Res({ passthrough: true }) res: RefreshCookieResponse) {
      this.sameOrigin(req);
      const result = await this.accounts.register(body, { ip: req.ip });
      if (!result.verificationRequired) return { verificationRequired: false, ...this.cookie.session(result, res) };
      return result;
    }
    @Post('verification') @Public() @HttpCode(200)
    resend(@Body() body: unknown, @Req() req: AccountRequest) {
      this.sameOrigin(req); return this.accounts.requestEmail(body, 'verify-email');
    }
    /** `{success: true}`; with `verification.signInOnVerify` also the session (cookie) or a two-factor challenge. */
    @Post('verify-email') @Public() @HttpCode(200)
    async verify(@Body() body: unknown, @Req() req: AccountRequest, @Res({ passthrough: true }) res: RefreshCookieResponse) {
      this.sameOrigin(req);
      const result = await this.accounts.consumeEmail(body, 'verify-email');
      return result.signIn ? { success: true, ...this.cookie.signedIn(result.signIn, res) } : { success: true };
    }
    @Post('forgot-password') @Public() @HttpCode(200)
    forgot(@Body() body: unknown, @Req() req: AccountRequest) {
      this.sameOrigin(req); return this.accounts.requestEmail(body, 'reset-password');
    }
    @Post('reset-password') @Public() @HttpCode(200)
    async reset(@Body() body: unknown, @Req() req: AccountRequest) {
      this.sameOrigin(req); await this.accounts.consumeEmail(body, 'reset-password'); return { success: true };
    }
    @Post('login') @Public() @HttpCode(200)
    async login(@Body() body: unknown, @Req() req: AccountRequest, @Res({ passthrough: true }) res: RefreshCookieResponse) {
      this.sameOrigin(req);
      // Per-target budgets on top of the per-IP guard: one for this account from this client, and a
      // looser one for the account across all clients (distributed guessing). Successful logins are refunded.
      // Compositions that do not configure these limiters keep only the per-IP guard.
      // A correct password with two-factor on returns `{twoFactorRequired: true, challenge}` and no cookie.
      const account = loginAccountKey(body);
      const refund = await spendBudgets(this.limiter, account
        ? [[LOGIN_LIMITER, `login:${account}:${req.ip ?? 'unknown-client'}`], [LOGIN_ACCOUNT_LIMITER, `login-account:${account}`]] : []);
      const result = await this.accounts.login(body);
      await refund();
      return this.cookie.signedIn(result, res);
    }
    /**
     * Second sign-in step: `{challenge, code}` or `{challenge, recoveryCode}` → session (cookie) as `login`.
     * Wrong codes spend the login budgets of the challenged account (per client and across clients) and
     * the TOTP lockout; the challenge stays usable until it expires or succeeds.
     */
    @when(twoFactor, Post('login/two-factor'), Public(), HttpCode(200))
    async loginTwoFactor(@Body() body: unknown, @Req() req: AccountRequest, @Res({ passthrough: true }) res: RefreshCookieResponse) {
      this.sameOrigin(req);
      const subject = await this.accounts.twoFactorChallengeSubject(body);
      const refund = await spendBudgets(this.limiter, subject
        ? [[LOGIN_LIMITER, `two-factor:${subject}:${req.ip ?? 'unknown-client'}`], [LOGIN_ACCOUNT_LIMITER, `two-factor-account:${subject}`],
          [TWO_FACTOR_LIMITER, `two-factor:${subject}`]] : []);
      const pair = await this.accounts.loginTwoFactor(body);
      await refund();
      return this.cookie.session(pair, res);
    }
    /** `{email}` → always `{accepted: true}` (account policy `magicLinkEnabled`; 403 `MAGIC_LINK_DISABLED` when off). */
    @when(magicLink, Post('magic-link'), Public(), HttpCode(200))
    magicLink(@Body() body: unknown, @Req() req: AccountRequest) {
      this.sameOrigin(req); return this.accounts.requestMagicLink(body);
    }
    /** `{ticket}` from the mailed link's fragment → session, or `{twoFactorRequired, challenge}`. */
    @when(magicLink, Post('magic-link/consume'), Public(), HttpCode(200))
    async consumeMagicLink(@Body() body: unknown, @Req() req: AccountRequest, @Res({ passthrough: true }) res: RefreshCookieResponse) {
      this.sameOrigin(req);
      return this.cookie.signedIn(await this.accounts.consumeMagicLink(body), res);
    }
    /**
     * Page loads restore their access token here, so this is not on the credential budget: a per-IP
     * ceiling (guard) plus a per-session budget once the cookie's signature is verified.
     */
    @Post('refresh') @Public() @HttpCode(200)
    @RateLimit(SESSION_REFRESH_NETWORK_LIMITER)
    async refresh(@Req() req: AccountRequest, @Res({ passthrough: true }) res: RefreshCookieResponse) {
      this.sameOrigin(req);
      const token = this.cookie.read(req) ?? '';
      const sessionId = await this.accounts.refreshSessionId(token);
      if (sessionId) {
        try { await this.limiter.consume(SESSION_REFRESH_LIMITER, `session:${sessionId}`); }
        catch (error) {
          if (error instanceof TooManyRequestsException) throw new TooManyRequestsException('Too many requests', error.retryAfter);
          throw error;
        }
      }
      const pair = await this.accounts.refresh(token);
      this.cookie.issue(res, pair.refreshToken);
      return { access_token: pair.accessToken };
    }
    @Post('logout') @HttpCode(200)
    async logout(@Req() req: AccountRequest, @Res({ passthrough: true }) res: RefreshCookieResponse) {
      this.sameOrigin(req);
      await this.accounts.sessions.revokeSessionForUser(req.user.sid, req.user.id, 'logout');
      this.cookie.clear(res);
      return { success: true };
    }
    @Get('me')
    @RateLimit({ limiter: SESSION_READ_LIMITER, keyExtractor: '#userId' })
    async me(@Req() req: AccountRequest) {
      const user = await this.accounts.currentUser(req.user.id, req.user.sid);
      const permissions = await this.permissions.findUserPermissions(user.id);
      return { ...(this.options.profile?.(user) ?? {}),
        id: user.id, username: user.username, name: user.name, email: user.email, emailVerified: user.emailVerified,
        permissions: permissions.map(permission => {
          const split = permission.lastIndexOf(':');
          return split < 0 ? { id: permission, actions: ['*'] } : { id: permission.slice(0, split), actions: [permission.slice(split + 1)] };
        }) };
    }
    @Post('password') @HttpCode(200)
    async changePassword(@Body() body: unknown, @Req() req: AccountRequest, @Res({ passthrough: true }) res: RefreshCookieResponse) {
      this.sameOrigin(req);
      const result = await this.accounts.changePassword(req.user.id, body);
      this.cookie.clear(res);
      return result;
    }
    @Post('profile') @HttpCode(200)
    updateProfile(@Body() body: unknown, @Req() req: AccountRequest) {
      this.sameOrigin(req); return this.accounts.updateProfile(req.user.id, body);
    }
    @Get('sessions')
    @RateLimit({ limiter: API_DEFAULT_LIMITER, keyExtractor: '#userId' })
    async sessions(@Req() req: AccountRequest) {
      return (await this.accounts.sessions.listUserSessions(req.user.id)).map(session => ({
        id: session.id, current: session.id === req.user.sid, expiresAt: session.expiresAt, lastActiveAt: session.lastActiveAt,
      }));
    }
    @Delete('sessions/:id')
    async revoke(@Param('id') id: string, @Req() req: AccountRequest, @Res({ passthrough: true }) res: RefreshCookieResponse) {
      this.sameOrigin(req);
      if (!await this.accounts.sessions.revokeSessionForUser(id, req.user.id, 'owner-revoked')) throw new ForbiddenException();
      if (id === req.user.sid) this.cookie.clear(res);
      return { success: true };
    }
  }
  return AccountController;
}

/** All account routes (register, magic link and two-factor step on); configure with `ACCOUNTS_OPTIONS`. */
export const AccountController = createAccountController();
