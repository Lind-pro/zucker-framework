import { Body, Controller, Header, HttpCode, Inject, Optional, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Permissions, Public, type RefreshCookieResponse } from '@zucker-framework/auth';
import { RateLimit, RateLimitGuard, RateLimiterService } from '@zucker-framework/rate-limiter';
import { assertAccountOrigin, spendBudgets, type AccountRequest } from '../account-security';
import { AccountSessionCookie } from '../account-session-cookie';
import { accountOrigins, resolveAccountsOptions, type ResolvedAccountsOptions } from '../accounts.options';
import { ACCOUNTS_OPTIONS } from '../accounts.tokens';
import { ACCOUNTS_LIMITER, LOGIN_ACCOUNT_LIMITER, LOGIN_LIMITER, loginAccountKey } from '../rate-limits';
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
  private readonly origins: ReadonlySet<string>;
  private readonly cookie: AccountSessionCookie;
  private readonly identifier: ResolvedAccountsOptions['login']['identifier'];
  constructor(private readonly deletions: AccountDeletionService, private readonly limiter: RateLimiterService,
    @Optional() @Inject(ACCOUNTS_OPTIONS) options?: ResolvedAccountsOptions) {
    const resolved = options ?? resolveAccountsOptions();
    this.identifier = resolved.login.identifier;
    this.origins = accountOrigins(resolved);
    this.cookie = new AccountSessionCookie(resolved);
  }

  /** `{confirm: <username>, reason?, password?}` → `{scheduled: true, executeAfter}`; signs this browser out. */
  @Post() @HttpCode(200) @Header('Cache-Control', 'private, no-store')
  async schedule(@Body() body: unknown, @Req() req: AccountRequest, @Res({ passthrough: true }) res: RefreshCookieResponse) {
    assertAccountOrigin(this.origins, req);
    const refund = await spendBudgets(this.limiter, [[LOGIN_ACCOUNT_LIMITER, `account-security:${req.user.id}`]]);
    const result = await this.deletions.schedule(req.user.id, req.user.sid, body);
    await refund();
    this.cookie.clear(res);
    return result;
  }

  /** `{<login identifier field>, password}` (`username` by default) or `{ticket}` → `{cancelled: true}`. */
  @Post('cancel') @Public() @HttpCode(200) @Header('Cache-Control', 'private, no-store')
  async cancel(@Body() body: unknown, @Req() req: Omit<AccountRequest, 'user'>) {
    assertAccountOrigin(this.origins, req);
    const account = loginAccountKey(body, this.identifier);
    const refund = await spendBudgets(this.limiter, account
      ? [[LOGIN_LIMITER, `login:${account}:${req.ip ?? 'unknown-client'}`], [LOGIN_ACCOUNT_LIMITER, `login-account:${account}`]] : []);
    const result = await this.deletions.cancel(body);
    await refund();
    return result;
  }
}
