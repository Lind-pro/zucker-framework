import { Module } from '@nestjs/common';
import { AccountService, ACCOUNT_MAILER } from './account.service';
import { AccountGuard } from './account.guard';
import { AccountController } from './account.controller';
import { MailAccountMailer } from './account-mailer';
import { AccountOnboarding } from './account-onboarding';
import { MailCoreModule } from '../mail/mail.module';

/**
 * Accounts. PolicyService (account policy) and JobsService (welcome-credit retry) are injected
 * optionally from their global modules; without them sign-up keeps the policy defaults.
 */
@Module({
  imports: [MailCoreModule],
  controllers: [AccountController],
  providers: [AccountService, AccountGuard, AccountOnboarding, MailAccountMailer,
    { provide: ACCOUNT_MAILER, useExisting: MailAccountMailer }],
  exports: [AccountService, AccountGuard, AccountOnboarding],
})
export class AccountModule {}
