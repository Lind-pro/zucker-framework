import { Inject, Injectable, Module } from '@nestjs/common';
import { DATABASE_ADAPTER, type DatabaseAdapter } from '@zucker-framework/core';
import { MailService, ZuckerMailModule } from '@zucker-framework/notification';
import {
  createMailLogAdminController, createMailTemplateAdminController, type MailTemplatePreview,
} from '@zucker-framework/admin';
import { SmtpTransport, SmtpTransportModule } from './smtp-transport';

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
 * One MailService with durable templates (`email_templates`) and delivery history (`email_logs`).
 * Delivery uses the application's shared SmtpTransport (the `account-email` connection profile, also
 * used by account mail); without it nothing is sent and the admin pages still work. Applications
 * register their own built-in templates and audiences here.
 */
@Module({
  imports: [ZuckerMailModule.forRootAsync({
    imports: [SmtpTransportModule],
    inject: [DATABASE_ADAPTER, SmtpTransport],
    useFactory: (...args: unknown[]) => {
      const [database, transport] = args as [DatabaseAdapter, SmtpTransport];
      return {
        database,
        providers: [transport],
        templates: { defaultLocale: 'en', contentFields: { en: 'htmlContentEn', zh: 'htmlContentZh' }, builtIns: [] },
      };
    },
  })],
  controllers: [
    // RFC 8.5. Global AccountGuard/PermissionsGuard enforce authentication and permission metadata.
    createMailTemplateAdminController({ path: 'management/email-templates', permissions: { read: 'mail:query', write: 'mail:update' },
      auditModule: 'mail', previewService: MailTemplatePreviewer, guards: [] }),
    createMailLogAdminController({ guards: [] }),
  ],
  providers: [MailTemplatePreviewer],
})
export class MailModule {}
