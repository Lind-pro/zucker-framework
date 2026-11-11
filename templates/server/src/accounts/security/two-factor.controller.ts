import { Body, Controller, Get, Header, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { Permissions } from '@zucker-framework/auth';
import { RateLimit, RateLimitGuard, RateLimiterService } from '@zucker-framework/rate-limiter';
import { ACCOUNTS_LIMITER, LOGIN_ACCOUNT_LIMITER } from '../../rate-limits';
import { AccountService } from '../account.service';
import { ACCOUNT_SECURITY_ERRORS as E, accountSecurityError } from './account-security.errors';
import { accountOrigins, assertAccountOrigin, spendBudgets, stringFields, type AccountSecurityRequest } from './account-request';
import { AccountTwoFactorService, secondFactor } from './two-factor.service';
import { TWO_FACTOR_LIMITER } from './account-security.limits';

/**
 * Self-service TOTP two-factor (`/authorize/two-factor/*`), signed-in owner only. Enrol, disable and
 * regenerate need recent authentication (`password` for password accounts; a session younger than
 * 10 minutes otherwise) and spend the account's login budget, so a stolen session cannot guess the
 * password or recovery codes at the per-IP rate. Secrets and recovery codes appear in exactly one
 * response each and are never logged.
 */
@Controller('authorize/two-factor')
@UseGuards(RateLimitGuard)
@RateLimit({ limiter: ACCOUNTS_LIMITER, keyExtractor: '#userId' })
@Permissions()
export class AccountTwoFactorController {
  private readonly origins = accountOrigins();
  constructor(private readonly accounts: AccountService, private readonly twoFactor: AccountTwoFactorService,
    private readonly limiter: RateLimiterService) {}

  private budget(req: AccountSecurityRequest) {
    return spendBudgets(this.limiter, [[LOGIN_ACCOUNT_LIMITER, `account-security:${req.user.id}`]]);
  }

  /** Second-factor guesses of this account (shared with the login step-up); refunded on success. */
  private factorBudget(req: AccountSecurityRequest) {
    return spendBudgets(this.limiter, [[TWO_FACTOR_LIMITER, `two-factor:${req.user.id}`]]);
  }

  /** `{available, status: 'off'|'pending'|'active', confirmedAt, recoveryCodesRemaining, enrolmentAllowed}` */
  @Get('status') @Header('Cache-Control', 'private, no-store')
  async status(@Req() req: AccountSecurityRequest) {
    const [status, policy] = await Promise.all([this.twoFactor.status(req.user.id), this.accounts.policy()]);
    return { ...status, enrolmentAllowed: status.available && policy.twoFactorEnabled };
  }

  /** `{password?}` → `{secret, otpauthUri}` (once); the enrolment stays `pending` until confirmed. */
  @Post('enrol') @HttpCode(200) @Header('Cache-Control', 'private, no-store')
  async enrol(@Req() req: AccountSecurityRequest, @Body() body: unknown) {
    assertAccountOrigin(this.origins, req);
    const input = stringFields(body, ['password']);
    if (!(await this.accounts.policy()).twoFactorEnabled) throw accountSecurityError(403, E.twoFactorDisabled, 'Two-factor enrolment is turned off');
    this.twoFactor.assertAvailable();
    const refund = await this.budget(req);
    const user = await this.accounts.assertRecentAuthentication(req.user.id, req.user.sid, input.password);
    await refund();
    return this.twoFactor.enrol(user);
  }

  /** `{code}` → `{recoveryCodes}` (once). Every other session of the account ends. */
  @Post('confirm') @HttpCode(200) @Header('Cache-Control', 'private, no-store')
  async confirm(@Req() req: AccountSecurityRequest, @Body() body: unknown) {
    assertAccountOrigin(this.origins, req);
    const input = stringFields(body, ['code']);
    await this.accounts.currentUser(req.user.id, req.user.sid);
    const refundFactor = await this.factorBudget(req);
    const result = await this.twoFactor.confirm(req.user.id, req.user.sid, input.code ?? '');
    await refundFactor();
    return result;
  }

  /** `{password?, code}` or `{password?, recoveryCode}` → `{success: true}`. */
  @Post('disable') @HttpCode(200) @Header('Cache-Control', 'private, no-store')
  async disable(@Req() req: AccountSecurityRequest, @Body() body: unknown) {
    assertAccountOrigin(this.origins, req);
    const input = stringFields(body, ['password', 'code', 'recoveryCode']);
    const factor = secondFactor(input);
    if (!factor) throw accountSecurityError(400, E.twoFactorCodeInvalid, 'Enter a 6-digit code or a recovery code');
    const refund = await this.budget(req);
    await this.accounts.assertRecentAuthentication(req.user.id, req.user.sid, input.password);
    const refundFactor = await this.factorBudget(req);
    const result = await this.twoFactor.disable(req.user.id, factor);
    await refund(); await refundFactor();
    return result;
  }

  /** `{password?, code}` → `{recoveryCodes}` (once); earlier codes stop working. */
  @Post('recovery-codes') @HttpCode(200) @Header('Cache-Control', 'private, no-store')
  async regenerate(@Req() req: AccountSecurityRequest, @Body() body: unknown) {
    assertAccountOrigin(this.origins, req);
    const input = stringFields(body, ['password', 'code']);
    const refund = await this.budget(req);
    await this.accounts.assertRecentAuthentication(req.user.id, req.user.sid, input.password);
    const refundFactor = await this.factorBudget(req);
    const result = await this.twoFactor.regenerateRecoveryCodes(req.user.id, input.code ?? '');
    await refund(); await refundFactor();
    return result;
  }
}
