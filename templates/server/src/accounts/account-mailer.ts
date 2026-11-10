import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { MAIL_TEMPLATE_KEYS } from '../mail/mail-templates';
import { TransactionalMail } from '../mail/transactional-mail';
import type { AccountMailer } from './account.service';

/**
 * Account mail through the shared MailService (`account.verify`, `account.reset`, `account.welcome`
 * templates, `email_logs` history). Tickets travel only in the URL fragment, so they never reach
 * HTTP access logs or referrers, and are never written to the mail log metadata.
 */
@Injectable()
export class MailAccountMailer implements AccountMailer {
  constructor(private readonly mail: TransactionalMail) {}
  assertConfigured(): void {
    if (!this.mail.isEnabled()) throw new ServiceUnavailableException('Account email is not configured');
  }
  async send(email: string, purpose: 'verify-email' | 'reset-password', ticket: string, locale: string, userId?: string): Promise<void> {
    this.assertConfigured();
    const result = await this.mail.send(purpose === 'verify-email' ? MAIL_TEMPLATE_KEYS.verify : MAIL_TEMPLATE_KEYS.reset, {
      to: email, locale, userId, data: { link: this.mail.link(locale, `/${purpose}`, { ticket }) },
      logMetadata: { purpose },
    });
    if (!result.success) throw new ServiceUnavailableException('Account email delivery failed; request a new link');
  }
  async welcome(email: string, locale: string, name: string, userId: string): Promise<void> {
    if (!this.mail.isEnabled()) return;
    const result = await this.mail.send(MAIL_TEMPLATE_KEYS.welcome, {
      to: email, locale, userId, data: { name, link: this.mail.link(locale, '/account') },
    });
    if (!result.success) throw new Error('Welcome mail delivery failed');
  }
}
