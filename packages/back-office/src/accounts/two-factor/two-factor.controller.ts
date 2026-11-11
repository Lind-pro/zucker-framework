import { Body, Controller, Get, Header, HttpCode, Inject, Logger, NotFoundException, Optional, Param, Post, Req, UseGuards } from '@nestjs/common';
import { PermissionService, Permissions } from '@zucker-framework/auth';
import { RateLimit, RateLimitGuard, RateLimiterService } from '@zucker-framework/rate-limiter';
import { ACCOUNT_SECURITY_ERRORS as E, accountSecurityError, assertAccountOrigin, spendBudgets, stringFields, type AccountRequest } from '../account-security';
import { AccountService } from '../account.service';
import { accountOrigins, resolveAccountsOptions, type ResolvedAccountsOptions } from '../accounts.options';
import type { AccountMailer } from '../accounts.ports';
import { ACCOUNTS_MAILER, ACCOUNTS_OPTIONS } from '../accounts.tokens';
import { ACCOUNT_SECURITY_ADMIN_LIMITER, ACCOUNTS_LIMITER, LOGIN_ACCOUNT_LIMITER, TWO_FACTOR_LIMITER } from '../rate-limits';
import { AccountTwoFactorService, secondFactor } from './two-factor.service';

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
  private readonly origins: ReadonlySet<string>;
  constructor(private readonly accounts: AccountService, private readonly twoFactor: AccountTwoFactorService,
    private readonly limiter: RateLimiterService, @Optional() @Inject(ACCOUNTS_OPTIONS) options?: ResolvedAccountsOptions) {
    this.origins = accountOrigins(options ?? resolveAccountsOptions());
  }

  private budget(req: AccountRequest) {
    return spendBudgets(this.limiter, [[LOGIN_ACCOUNT_LIMITER, `account-security:${req.user.id}`]]);
  }
  /** Second-factor guesses of this account (shared with the login step-up); refunded on success. */
  private factorBudget(req: AccountRequest) {
    return spendBudgets(this.limiter, [[TWO_FACTOR_LIMITER, `two-factor:${req.user.id}`]]);
  }

  /** `{available, status: 'off'|'pending'|'active', confirmedAt, recoveryCodesRemaining, enrolmentAllowed}` */
  @Get('status') @Header('Cache-Control', 'private, no-store')
  async status(@Req() req: AccountRequest) {
    const [status, policy] = await Promise.all([this.twoFactor.status(req.user.id), this.accounts.policy()]);
    return { ...status, enrolmentAllowed: status.available && policy.twoFactorEnabled };
  }

  /** `{password?}` → `{secret, otpauthUri}` (once); the enrolment stays `pending` until confirmed. */
  @Post('enrol') @HttpCode(200) @Header('Cache-Control', 'private, no-store')
  async enrol(@Req() req: AccountRequest, @Body() body: unknown) {
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
  async confirm(@Req() req: AccountRequest, @Body() body: unknown) {
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
  async disable(@Req() req: AccountRequest, @Body() body: unknown) {
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
  async regenerate(@Req() req: AccountRequest, @Body() body: unknown) {
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

/**
 * Back office: reset another account's two-factor authentication (lost authenticator and recovery codes).
 * `users:update` (superadmin passes), trusted Origin, recent authentication of the acting staff member
 * (`password`, or a session younger than 10 minutes for password-less staff), and only a superadmin may
 * reset a superadmin. The reset, session revocation and audit row commit together; the account owner is
 * mailed afterwards (best effort).
 */
@Controller('management/users')
@UseGuards(RateLimitGuard)
@RateLimit({ limiter: ACCOUNT_SECURITY_ADMIN_LIMITER, keyExtractor: '#userId' })
export class AccountTwoFactorAdminController {
  private readonly logger = new Logger(AccountTwoFactorAdminController.name);
  private readonly origins: ReadonlySet<string>;
  constructor(private readonly accounts: AccountService, private readonly twoFactor: AccountTwoFactorService,
    private readonly permissions: PermissionService, @Inject(ACCOUNTS_MAILER) private readonly mailer: AccountMailer,
    @Optional() @Inject(ACCOUNTS_OPTIONS) options?: ResolvedAccountsOptions) {
    this.origins = accountOrigins(options ?? resolveAccountsOptions());
  }

  /** `{password?}` → `{reset: true}`. 400 self, 403 recent-auth codes / superadmin target, 404, 409 `TWO_FACTOR_NOT_ENABLED`. */
  @Post(':id/two-factor/reset') @Permissions('users:update') @HttpCode(200) @Header('Cache-Control', 'private, no-store')
  async reset(@Req() req: AccountRequest, @Param('id') userId: string, @Body() body: unknown) {
    assertAccountOrigin(this.origins, req);
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(userId)) throw new NotFoundException();
    const input = stringFields(body, ['password']);
    if (userId === req.user.id) throw accountSecurityError(400, E.twoFactorResetSelf, 'Use your own security settings to change your two-factor authentication');
    await this.accounts.assertRecentAuthentication(req.user.id, req.user.sid, input.password);
    const [actor, target] = await Promise.all([this.permissions.findUserPermissions(req.user.id), this.permissions.findUserPermissions(userId)]);
    if (target.includes('superadmin') && !actor.includes('superadmin')) {
      throw accountSecurityError(403, E.twoFactorResetForbidden, 'Only a superadmin can reset a superadmin\'s two-factor authentication');
    }
    const owner = await this.twoFactor.adminReset(req.user.id, userId,
      { method: 'POST', path: `/management/users/${userId}/two-factor/reset`, ipAddress: req.ip });
    if (owner.email && this.mailer.twoFactorReset) {
      const email = owner.email;
      this.accounts.runInBackground('two-factor-reset', () => this.mailer.twoFactorReset!(email, owner.locale ?? this.accounts.options.locales.default, userId));
    } else if (!owner.email) {
      this.logger.warn('Two-factor reset of an account without an email address: the owner was not notified');
    }
    return { reset: true };
  }
}
