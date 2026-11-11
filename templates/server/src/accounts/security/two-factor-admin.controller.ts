import { Body, Controller, Header, HttpCode, Inject, Logger, NotFoundException, Param, Post, Req, UseGuards } from '@nestjs/common';
import { PermissionService, Permissions } from '@zucker-framework/auth';
import { RateLimit, RateLimitGuard } from '@zucker-framework/rate-limiter';
import { ACCOUNT_MAILER, AccountService, type AccountMailer } from '../account.service';
import { ACCOUNT_SECURITY_ERRORS as E, accountSecurityError } from './account-security.errors';
import { accountOrigins, assertAccountOrigin, stringFields, type AccountSecurityRequest } from './account-request';
import { ACCOUNT_SECURITY_ADMIN_LIMITER } from './account-security.limits';
import { AccountTwoFactorService } from './two-factor.service';

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
  private readonly origins = accountOrigins();
  constructor(private readonly accounts: AccountService, private readonly twoFactor: AccountTwoFactorService,
    private readonly permissions: PermissionService, @Inject(ACCOUNT_MAILER) private readonly mailer: AccountMailer) {}

  /** `{password?}` → `{reset: true}`. 400 self, 403 recent-auth codes / superadmin target, 404, 409 `TWO_FACTOR_NOT_ENABLED`. */
  @Post(':id/two-factor/reset') @Permissions('users:update') @HttpCode(200) @Header('Cache-Control', 'private, no-store')
  async reset(@Req() req: AccountSecurityRequest,
    @Param('id') userId: string, @Body() body: unknown) {
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
      this.accounts.runInBackground('two-factor-reset', () => this.mailer.twoFactorReset!(email, owner.locale ?? 'en', userId));
    } else if (!owner.email) {
      this.logger.warn('Two-factor reset of an account without an email address: the owner was not notified');
    }
    return { reset: true };
  }
}
