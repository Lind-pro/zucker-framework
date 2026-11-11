import { Body, Controller, Delete, ForbiddenException, Get, HttpCode, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import { PermissionService, Permissions, Public, RefreshTokenCookie } from '@zucker-framework/auth';
import type { RefreshCookieResponse } from '@zucker-framework/auth';
import { RateLimit, RateLimitGuard, RateLimiterService, TooManyRequestsException } from '@zucker-framework/rate-limiter';
import { spendBudgets } from './security/account-request';
import { TWO_FACTOR_LIMITER } from './security/account-security.limits';
import { AccountService, ACCESS_TTL_SECONDS, SESSION_TTL_SECONDS, type SessionPair, type SignInResult } from './account.service';
import { ACCOUNTS_LIMITER, LOGIN_ACCOUNT_LIMITER, LOGIN_LIMITER, loginAccountKey, SESSION_READ_LIMITER, SESSION_REFRESH_LIMITER, SESSION_REFRESH_NETWORK_LIMITER } from '../rate-limits';

interface AccountRequest {
  ip?: string;
  headers: { cookie?: string; origin?: string; 'sec-fetch-site'?: string };
  user: { id: string; sid: string };
}

@Controller('authorize')
@UseGuards(RateLimitGuard)
@RateLimit(ACCOUNTS_LIMITER)
@Permissions()
export class AccountController {
  private readonly cookie = new RefreshTokenCookie({ name: 'zucker-session', path: '/',
    secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: SESSION_TTL_SECONDS * 1000 });
  private readonly origins = new Set((process.env.ACCOUNT_ORIGINS ?? 'http://localhost:4201,http://localhost:4202').split(',').map(value => value.trim()));
  constructor(private readonly accounts: AccountService, private readonly permissions: PermissionService,
    private readonly limiter: RateLimiterService) {}

  /** Session pair → cookie + public body; a challenge is returned as is and sets no cookie. */
  private signedIn(result: SignInResult, res: RefreshCookieResponse) {
    if (result.twoFactorRequired) return { twoFactorRequired: true as const, challenge: result.challenge };
    return this.session(result, res);
  }
  private session(pair: SessionPair, res: RefreshCookieResponse) {
    this.cookie.issue(res, pair.refreshToken);
    return { userId: pair.userId, token: pair.accessToken, expires: ACCESS_TTL_SECONDS * 1000 };
  }

  private sameOrigin(req: AccountRequest): void {
    if (!req.headers.origin || !this.origins.has(req.headers.origin) || req.headers['sec-fetch-site'] === 'cross-site') {
      throw new ForbiddenException('Untrusted account request origin');
    }
  }

  /**
   * `{verificationRequired: true}` (ticket mailed), or with the account policy's verification off a
   * signed-in session: `{verificationRequired: false, userId, token, expires}` plus the refresh cookie.
   */
  @Post('register') @Public()
  async register(@Body() body: unknown, @Req() req: AccountRequest, @Res({ passthrough: true }) res: RefreshCookieResponse) {
    this.sameOrigin(req);
    const result = await this.accounts.register(body, { ip: req.ip });
    if (!result.verificationRequired) return { verificationRequired: false, ...this.session(result, res) };
    return result;
  }
  @Post('verification') @Public() @HttpCode(200)
  resend(@Body() body: unknown, @Req() req: AccountRequest) {
    this.sameOrigin(req); return this.accounts.requestEmail(body, 'verify-email');
  }
  @Post('verify-email') @Public() @HttpCode(200)
  verify(@Body() body: unknown, @Req() req: AccountRequest) {
    this.sameOrigin(req); return this.accounts.consumeEmail(body, 'verify-email');
  }
  @Post('forgot-password') @Public() @HttpCode(200)
  forgot(@Body() body: unknown, @Req() req: AccountRequest) {
    this.sameOrigin(req); return this.accounts.requestEmail(body, 'reset-password');
  }
  @Post('reset-password') @Public() @HttpCode(200)
  reset(@Body() body: unknown, @Req() req: AccountRequest) {
    this.sameOrigin(req); return this.accounts.consumeEmail(body, 'reset-password');
  }
  @Post('login') @Public() @HttpCode(200)
  async login(@Body() body: unknown, @Req() req: AccountRequest, @Res({ passthrough: true }) res: RefreshCookieResponse) {
    this.sameOrigin(req);
    // Per-target budgets on top of the per-IP guard: one for this account from this client, and a
    // looser one for the account across all clients (distributed guessing). Successful logins are refunded.
    // Compositions that do not configure these limiters (e.g. narrow test modules) keep only the per-IP guard.
    // A correct password with two-factor on returns `{twoFactorRequired: true, challenge}` and no cookie.
    const account = loginAccountKey(body);
    const refund = await spendBudgets(this.limiter, account
      ? [[LOGIN_LIMITER, `login:${account}:${req.ip ?? 'unknown-client'}`], [LOGIN_ACCOUNT_LIMITER, `login-account:${account}`]] : []);
    const result = await this.accounts.login(body);
    await refund();
    return this.signedIn(result, res);
  }
  /**
   * Second sign-in step: `{challenge, code}` or `{challenge, recoveryCode}` → session (cookie) as `login`.
   * Wrong codes spend the login budgets of the challenged account (per client and across clients) and
   * the TOTP lockout; the challenge stays usable until it expires (5 minutes) or succeeds.
   */
  @Post('login/two-factor') @Public() @HttpCode(200)
  async loginTwoFactor(@Body() body: unknown, @Req() req: AccountRequest, @Res({ passthrough: true }) res: RefreshCookieResponse) {
    this.sameOrigin(req);
    const subject = await this.accounts.twoFactorChallengeSubject(body);
    const refund = await spendBudgets(this.limiter, subject
      ? [[LOGIN_LIMITER, `two-factor:${subject}:${req.ip ?? 'unknown-client'}`], [LOGIN_ACCOUNT_LIMITER, `two-factor-account:${subject}`],
        [TWO_FACTOR_LIMITER, `two-factor:${subject}`]] : []);
    const pair = await this.accounts.loginTwoFactor(body);
    await refund();
    return this.session(pair, res);
  }
  /** `{email}` → always `{accepted: true}` (account policy `magicLinkEnabled`; 403 `MAGIC_LINK_DISABLED` when off). */
  @Post('magic-link') @Public() @HttpCode(200)
  magicLink(@Body() body: unknown, @Req() req: AccountRequest) {
    this.sameOrigin(req); return this.accounts.requestMagicLink(body);
  }
  /** `{ticket}` from the mailed link's fragment → session, or `{twoFactorRequired, challenge}`. */
  @Post('magic-link/consume') @Public() @HttpCode(200)
  async consumeMagicLink(@Body() body: unknown, @Req() req: AccountRequest, @Res({ passthrough: true }) res: RefreshCookieResponse) {
    this.sameOrigin(req);
    return this.signedIn(await this.accounts.consumeMagicLink(body), res);
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
    return { id: user.id, username: user.username, name: user.name, email: user.email, emailVerified: user.emailVerified,
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
  @RateLimit({ limiter: 'api-default', keyExtractor: '#userId' })
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
