import { Inject, Injectable, Module } from '@nestjs/common';
import { DATABASE_ADAPTER, type DatabaseAdapter } from '@zucker-framework/core';
import { MailService, ZuckerMailModule } from '@zucker-framework/notification';
import {
  createMailLogAdminController, createMailTemplateAdminController, type MailTemplatePreview,
} from '@zucker-framework/admin';
import { ApplicationMailTransport } from './mail-transport';
import { ACCOUNT_MAIL_TEMPLATES } from './mail-templates';
import { SmtpTransportModule } from './smtp-transport';
import { TransactionalMail } from './transactional-mail';
import { BillingReceiptMail } from './billing-receipt.runtime';

/** Template-owned preview: stored template text, interpolated with no business sample data. */
@Injectable()
export class MailTemplatePreviewer implements MailTemplatePreview {
  constructor(@Inject(MailService) private readonly mail: MailService) {}
  async previewTemplate(key: string, locale: string) {
    const html = this.mail.templates.select(await this.mail.templates.resolve(key), locale);
    return { html: this.mail.templates.interpolate(html, {}) };
  }
  renderRawHtml(html: string): string { return html; }
}

/**
 * One MailService with durable templates (`email_templates`), the built-in account/billing templates
 * and delivery history (`email_logs`). Delivery uses ApplicationMailTransport (the `account-email`
 * connection profile: SMTP or Resend); without it nothing is sent and the admin pages still work.
 * Imported by both AccountModule (account mail) and MailModule; Nest builds it once.
 */
@Module({
  imports: [SmtpTransportModule, ZuckerMailModule.forRootAsync({
    imports: [SmtpTransportModule],
    inject: [DATABASE_ADAPTER, ApplicationMailTransport],
    useFactory: (...args: unknown[]) => {
      const [database, transport] = args as [DatabaseAdapter, ApplicationMailTransport];
      return {
        database,
        providers: [transport],
        templates: { defaultLocale: 'en', contentFields: { en: 'htmlContentEn', zh: 'htmlContentZh' }, builtIns: ACCOUNT_MAIL_TEMPLATES },
      };
    },
  })],
  providers: [TransactionalMail],
  exports: [TransactionalMail, SmtpTransportModule],
})
export class MailCoreModule {}

@Module({
  imports: [MailCoreModule],
  controllers: [
    // RFC 8.5. Global AccountGuard/PermissionsGuard enforce authentication and permission metadata.
    createMailTemplateAdminController({ path: 'management/email-templates', permissions: { read: 'mail:query', write: 'mail:update' },
      auditModule: 'mail', previewService: MailTemplatePreviewer, guards: [] }),
    createMailLogAdminController({ guards: [] }),
  ],
  // Receipt mail is a consumer of the billing fulfillment outbox; it needs the global JobsModule.
  providers: [MailTemplatePreviewer, BillingReceiptMail],
})
export class MailModule {}
