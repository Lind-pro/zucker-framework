import { Inject, Injectable, Module, Optional } from '@nestjs/common';
import { ACCOUNT_MAIL_TEMPLATES, BackOfficeMailModule, type BackOfficeMailOptions, type MailSitePort } from '@zucker-framework/back-office/mail';
import { RUNTIME_ENVIRONMENT } from '../runtime-settings/runtime-settings.tokens';
import { RuntimeMailSettings, SmtpTransportModule } from './smtp-transport';
import { BillingReceiptMail } from './billing-receipt.runtime';

/** Public origin (`WEB_URL`) and display name (`SITE_NAME`) of the mails, from the runtime environment. */
@Injectable()
export class TemplateMailSite implements MailSitePort {
  readonly webUrl?: string;
  readonly siteName?: string;
  constructor(@Optional() @Inject(RUNTIME_ENVIRONMENT) environment?: Readonly<NodeJS.ProcessEnv>) {
    const env = environment ?? process.env;
    this.webUrl = env.WEB_URL;
    this.siteName = env.SITE_NAME;
  }
}

/**
 * One MailService with durable templates (`email_templates`), the built-in account/billing templates
 * and delivery history (`email_logs`), from `@zucker-framework/back-office/mail`. Delivery uses the
 * `account-email` connection profile (SMTP or Resend), hot-applied; without it nothing is sent and the
 * admin pages still work. The same module value is imported by AccountModule and MailModule (built once).
 */
const MAIL_OPTIONS = {
  settings: RuntimeMailSettings,
  site: TemplateMailSite,
  templates: { builtIns: ACCOUNT_MAIL_TEMPLATES },
  // RFC 8.5. Global AccountGuard/PermissionsGuard enforce authentication and permission metadata.
  admin: { guards: [] },
} satisfies BackOfficeMailOptions;
// Admin routes are mounted by MailModule only; the account mailer (`MAIL_ACCOUNT_MAILER`) is AccountModule's mail port.
export const MailCoreModule = BackOfficeMailModule.forRoot({ ...MAIL_OPTIONS, imports: [SmtpTransportModule], features: { admin: false, accountMailer: true } });

@Module({
  imports: [MailCoreModule, BackOfficeMailModule.adminControllers(MAIL_OPTIONS)],
  // Receipt mail is a consumer of the billing fulfillment outbox; it needs the global JobsModule.
  providers: [BillingReceiptMail],
})
export class MailModule {}
