import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { MAIL_TEMPLATE_KEYS } from '../mail/mail-templates';
import { TransactionalMail } from '../mail/transactional-mail';
import type { AccountMailer, AccountMailPurpose } from './account.service';

const TICKET_MAIL = {
  'verify-email': { key: MAIL_TEMPLATE_KEYS.verify, path: '/verify-email' },
  'reset-password': { key: MAIL_TEMPLATE_KEYS.reset, path: '/reset-password' },
  'magic-link': { key: MAIL_TEMPLATE_KEYS.magicLink, path: '/magic-link' },
} as const;

/**
 * Account mail through the shared MailService (`account.verify`, `account.reset`, `account.welcome`,
 * `account.magic-link`, `account.deletion-*` templates, `email_logs` history). Tickets travel only in the URL fragment, so they never reach
 * HTTP access logs or referrers, and are never written to the mail log metadata.
 */
@Injectable()
export class MailAccountMailer implements AccountMailer {
  constructor(private readonly mail: TransactionalMail) {}
  assertConfigured(): void {
    if (!this.mail.isEnabled()) throw new ServiceUnavailableException('Account email is not configured');
  }
  async send(email: string, purpose: AccountMailPurpose, ticket: string, locale: string, userId?: string): Promise<void> {
    this.assertConfigured();
    const target = TICKET_MAIL[purpose];
    if (!target) throw new Error('Unsupported account mail purpose');
    const result = await this.mail.send(target.key, {
      to: email, locale, userId, data: { link: this.mail.link(locale, target.path, { ticket }) },
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
  /** Cancel link in `/<locale>/login#cancel-deletion=<ticket>`; throws on delivery failure (caller logs it). */
  async deletionScheduled(email: string, locale: string, userId: string, notice: { ticket: string; executeAfter: Date }): Promise<void> {
    if (!this.mail.isEnabled()) return;
    const result = await this.mail.send(MAIL_TEMPLATE_KEYS.deletionScheduled, {
      to: email, locale, userId, logMetadata: { purpose: 'deletion-scheduled' },
      data: { executeAfter: `${notice.executeAfter.toISOString().slice(0, 16).replace('T', ' ')} UTC`,
        link: this.mail.link(locale, '/login', { 'cancel-deletion': notice.ticket }) },
    });
    if (!result.success) throw new Error('Deletion notice delivery failed');
  }
  /** Staff turned two-factor off for this account; link to the security page. Throws on delivery failure (caller logs it). */
  async twoFactorReset(email: string, locale: string, userId: string): Promise<void> {
    if (!this.mail.isEnabled()) return;
    const result = await this.mail.send(MAIL_TEMPLATE_KEYS.twoFactorReset, {
      to: email, locale, userId, logMetadata: { purpose: 'two-factor-reset' },
      data: { link: this.mail.link(locale, '/account/security') },
    });
    if (!result.success) throw new Error('Two-factor reset notice delivery failed');
  }
  /** Sent without a user id; the caller removes the resulting log row so the address is not retained. */
  async deletionCompleted(email: string, locale: string): Promise<void> {
    if (!this.mail.isEnabled()) return;
    const result = await this.mail.send(MAIL_TEMPLATE_KEYS.deletionCompleted, { to: email, locale, data: {} });
    if (!result.success) throw new Error('Deletion confirmation delivery failed');
  }
}
