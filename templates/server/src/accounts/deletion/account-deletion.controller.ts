import { Body, Controller, Header, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Permissions, Public, RefreshTokenCookie, type RefreshCookieResponse } from '@zucker-framework/auth';
import { RateLimit, RateLimitGuard, RateLimiterService } from '@zucker-framework/rate-limiter';
import { ACCOUNTS_LIMITER, LOGIN_ACCOUNT_LIMITER, LOGIN_LIMITER, loginAccountKey } from '../../rate-limits';
import { SESSION_TTL_SECONDS } from '../account.service';
import { accountOrigins, assertAccountOrigin, spendBudgets, type AccountSecurityRequest } from '../security/account-request';
import { AccountDeletionService } from './account-deletion.service';

/**
 * `/authorize/deletion` (signed-in owner, recent authentication, trusted Origin) and
 * `/authorize/deletion/cancel` (public: password or mailed ticket, on the login budgets).
 */
@Controller('authorize/deletion')
@UseGuards(RateLimitGuard)
@RateLimit(ACCOUNTS_LIMITER)
@Permissions()
export class AccountDeletionController {
  private readonly origins = accountOrigins();
  private readonly cookie = new RefreshTokenCookie({ name: 'zucker-session', path: '/',
    secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: SESSION_TTL_SECONDS * 1000 });
  constructor(private readonly deletions: AccountDeletionService, private readonly limiter: RateLimiterService) {}

  /** `{confirm: <username>, reason?, password?}` → `{scheduled: true, executeAfter}`; signs this browser out. */
  @Post() @HttpCode(200) @Header('Cache-Control', 'private, no-store')
  async schedule(@Body() body: unknown, @Req() req: AccountSecurityRequest, @Res({ passthrough: true }) res: RefreshCookieResponse) {
    assertAccountOrigin(this.origins, req);
    const refund = await spendBudgets(this.limiter, [[LOGIN_ACCOUNT_LIMITER, `account-security:${req.user.id}`]]);
    const result = await this.deletions.schedule(req.user.id, req.user.sid, body);
    await refund();
    this.cookie.clear(res);
    return result;
  }

  /** `{username, password}` or `{ticket}` → `{cancelled: true}`. */
  @Post('cancel') @Public() @HttpCode(200) @Header('Cache-Control', 'private, no-store')
  async cancel(@Body() body: unknown, @Req() req: Omit<AccountSecurityRequest, 'user'>) {
    assertAccountOrigin(this.origins, req);
    const account = loginAccountKey(body);
    const refund = await spendBudgets(this.limiter, account
      ? [[LOGIN_LIMITER, `login:${account}:${req.ip ?? 'unknown-client'}`], [LOGIN_ACCOUNT_LIMITER, `login-account:${account}`]] : []);
    const result = await this.deletions.cancel(body);
    await refund();
    return result;
  }
}
