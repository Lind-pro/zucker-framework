import { Module } from '@nestjs/common';
import { AccountService, ACCOUNT_MAILER } from './account.service';
import { AccountGuard } from './account.guard';
import { AccountController } from './account.controller';
import { SmtpAccountMailer } from './account-mailer';
import { RUNTIME_ENVIRONMENT } from '../runtime-settings/runtime-settings.tokens';

@Module({
  controllers: [AccountController],
  providers: [AccountService, AccountGuard, { provide: SmtpAccountMailer,
    inject: [{ token: RUNTIME_ENVIRONMENT, optional: true }],
    useFactory: (environment?: Readonly<NodeJS.ProcessEnv>) => new SmtpAccountMailer(environment ?? process.env) },
    { provide: ACCOUNT_MAILER, useExisting: SmtpAccountMailer }],
  exports: [AccountService, AccountGuard],
})
export class AccountModule {}
