import { Body, Controller, Delete, ForbiddenException, Get, HttpCode, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import { PermissionService, Permissions, Public, RefreshTokenCookie } from '@zucker-framework/auth';
import type { RefreshCookieResponse } from '@zucker-framework/auth';
import { RateLimit, RateLimitGuard, RateLimiterService, TooManyRequestsException } from '@zucker-framework/rate-limiter';
import { AccountService, ACCESS_TTL_SECONDS, SESSION_TTL_SECONDS } from './account.service';
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
    if (!result.verificationRequired) {
      this.cookie.issue(res, result.refreshToken);
      return { verificationRequired: false, userId: result.userId, token: result.accessToken, expires: ACCESS_TTL_SECONDS * 1000 };
    }
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
    const account = loginAccountKey(body), keys = account
      ? ([[LOGIN_LIMITER, `login:${account}:${req.ip ?? 'unknown-client'}`], [LOGIN_ACCOUNT_LIMITER, `login-account:${account}`]] as const)
        .filter(([limiter]) => this.limiter.has(limiter))
      : [];
    for (const [limiter, key] of keys) {
      try { await this.limiter.consume(limiter, key); }
      catch (error) {
        if (error instanceof TooManyRequestsException) throw new TooManyRequestsException('Too many requests', error.retryAfter);
        throw error;
      }
    }
    const pair = await this.accounts.login(body);
    await Promise.all(keys.map(([limiter, key]) => this.limiter.reward(limiter, key).catch(() => undefined)));
    this.cookie.issue(res, pair.refreshToken);
    return { userId: pair.userId, token: pair.accessToken, expires: ACCESS_TTL_SECONDS * 1000 };
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
