import { Module } from '@nestjs/common';
import { AccountService, ACCOUNT_MAILER } from './account.service';
import { AccountGuard } from './account.guard';
import { AccountController } from './account.controller';
import { SmtpAccountMailer } from './account-mailer';
import { RUNTIME_ENVIRONMENT } from '../runtime-settings/runtime-settings.tokens';
import { SmtpTransport, SmtpTransportModule } from '../mail/smtp-transport';

@Module({
  imports: [SmtpTransportModule],
  controllers: [AccountController],
  providers: [AccountService, AccountGuard, { provide: SmtpAccountMailer,
    inject: [SmtpTransport, { token: RUNTIME_ENVIRONMENT, optional: true }],
    useFactory: (transport: SmtpTransport, environment?: Readonly<NodeJS.ProcessEnv>) =>
      new SmtpAccountMailer(transport, (environment ?? process.env).WEB_URL ?? '') },
    { provide: ACCOUNT_MAILER, useExisting: SmtpAccountMailer }],
  exports: [AccountService, AccountGuard],
})
export class AccountModule {}
