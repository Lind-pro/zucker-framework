import { Module } from '@nestjs/common';
import { AccountService, ACCOUNT_MAILER } from './account.service';
import { AccountGuard } from './account.guard';
import { AccountController } from './account.controller';
import { MailAccountMailer } from './account-mailer';
import { AccountOnboarding } from './account-onboarding';
import { MailCoreModule } from '../mail/mail.module';
import { ACCOUNT_SECURITY_CLOCK, systemAccountSecurityClock } from './security/account-security.clock';
import { AccountTwoFactorService } from './security/two-factor.service';
import { AccountTwoFactorController } from './security/two-factor.controller';
import { AccountTwoFactorAdminController } from './security/two-factor-admin.controller';

/**
 * Accounts. PolicyService (account policy) and JobsService (welcome-credit retry) are injected
 * optionally from their global modules; without them sign-up keeps the policy defaults.
 * Two-factor (TOTP) lives here because every sign-in path ends in `AccountService.completeSignIn`;
 * account deletion is the separate `AccountDeletionModule.forRoot()` (it composes other features).
 */
@Module({
  imports: [MailCoreModule],
  controllers: [AccountController, AccountTwoFactorController, AccountTwoFactorAdminController],
  providers: [AccountService, AccountGuard, AccountOnboarding, MailAccountMailer, AccountTwoFactorService,
    { provide: ACCOUNT_MAILER, useExisting: MailAccountMailer },
    { provide: ACCOUNT_SECURITY_CLOCK, useValue: systemAccountSecurityClock }],
  exports: [AccountService, AccountGuard, AccountOnboarding, AccountTwoFactorService, ACCOUNT_MAILER, ACCOUNT_SECURITY_CLOCK],
})
export class AccountModule {}
