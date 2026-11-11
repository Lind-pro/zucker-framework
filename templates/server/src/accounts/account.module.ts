import { Module } from '@nestjs/common';
import { BackOfficeAccountsModule } from '@zucker-framework/back-office/accounts';
import { templateAccountOptions } from './account.config';

/** `/authorize/*` core, two-factor and the template's mail/policy/onboarding ports (see account.config.ts). */
@Module({ imports: [BackOfficeAccountsModule.forRoot(templateAccountOptions())], exports: [BackOfficeAccountsModule] })
export class AccountModule {}
