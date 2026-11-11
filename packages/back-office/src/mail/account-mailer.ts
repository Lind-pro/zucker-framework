import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { MAIL_TEMPLATE_KEYS, VERIFICATION_CODE_MAIL_KEY } from './mail-templates';
import { TransactionalMail } from './transactional-mail';

/** Ticket mails of the accounts host. */
export type AccountMailPurpose = 'verify-email' | 'reset-password' | 'magic-link';

/**
 * Structural contract the accounts host consumes (declared again there; keep both in sync).
 * Ticket-link and code mails throw 503 on failure; notices are best effort and throw a plain Error
 * on delivery failure (the caller logs it) and are no-ops without a transport.
 */
export interface AccountMailerPort {
  assertConfigured(): void;
  send(email: string, purpose: AccountMailPurpose, ticket: string, locale: string, userId?: string): Promise<void>;
  code?(email: string, purpose: AccountMailPurpose | 'login', code: string, locale: string, userId?: string): Promise<void>;
  welcome?(email: string, locale: string, name: string, userId: string): Promise<void>;
  deletionScheduled?(email: string, locale: string, userId: string, notice: { ticket: string; executeAfter: Date }): Promise<void>;
  deletionCompleted?(email: string, locale: string): Promise<void>;
  twoFactorReset?(email: string, locale: string, userId: string): Promise<void>;
}

const minute = (date: Date) => `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;

/**
 * Account mail through the shared MailService (`account.*` templates, mail log history). Tickets travel
 * only in the URL fragment, so they never reach HTTP access logs or referrers, and are never written
 * to the mail log metadata. Codes are never logged either (only the purpose is).
 */
@Injectable()
export class BackOfficeAccountMailer implements AccountMailerPort {
  private readonly logger = new Logger(BackOfficeAccountMailer.name);
  constructor(@Inject(TransactionalMail) private readonly mail: TransactionalMail) {}
  private get links() { return this.mail.options.links; }

  assertConfigured(): void {
    if (!this.mail.isEnabled()) throw new ServiceUnavailableException('Account email is not configured');
  }
  async send(email: string, purpose: AccountMailPurpose, ticket: string, locale: string, userId?: string): Promise<void> {
    this.assertConfigured();
    const target = purpose === 'verify-email' ? { key: MAIL_TEMPLATE_KEYS.verify, path: this.links.verifyEmail }
      : purpose === 'reset-password' ? { key: MAIL_TEMPLATE_KEYS.reset, path: this.links.resetPassword }
        : purpose === 'magic-link' ? { key: MAIL_TEMPLATE_KEYS.magicLink, path: this.links.magicLink } : null;
    if (!target) throw new Error('Unsupported account mail purpose');
    const result = await this.mail.send(target.key, {
      to: email, locale, userId, data: { link: this.mail.link(locale, target.path, { ticket }) }, logMetadata: { purpose },
    });
    if (!result.success) throw new ServiceUnavailableException('Account email delivery failed; request a new link');
  }
  /** Six-digit (or any short) code; needs `VERIFICATION_CODE_MAIL_TEMPLATE` among the built-ins or a stored row. */
  async code(email: string, purpose: AccountMailPurpose | 'login', code: string, locale: string, userId?: string, minutes = 15): Promise<void> {
    if (!this.mail.canSend()) throw new ServiceUnavailableException('Account email is not configured');
    let delivered = false;
    try {
      const result = await this.mail.send(VERIFICATION_CODE_MAIL_KEY, {
        to: email, locale, userId, data: { code, minutes }, logMetadata: { purpose: `code:${purpose}` },
      });
      delivered = result.success;
    } catch (error) {
      // Any failure (also a missing template) is a delivery failure for the caller: 503, never the code.
      this.logger.warn(`Verification code mail failed: ${error instanceof Error ? error.name : 'error'}`);
    }
    if (!delivered) throw new ServiceUnavailableException('Account email delivery failed; request a new code');
  }
  async welcome(email: string, locale: string, name: string, userId: string): Promise<void> {
    if (!this.mail.isEnabled()) return;
    const result = await this.mail.send(MAIL_TEMPLATE_KEYS.welcome, { to: email, locale, userId, data: { name, link: this.mail.link(locale, this.links.welcome) } });
    if (!result.success) throw new Error('Welcome mail delivery failed');
  }
  /** Cancel link in `<deletionCancel>#cancel-deletion=<ticket>`. */
  async deletionScheduled(email: string, locale: string, userId: string, notice: { ticket: string; executeAfter: Date }): Promise<void> {
    if (!this.mail.isEnabled()) return;
    const result = await this.mail.send(MAIL_TEMPLATE_KEYS.deletionScheduled, {
      to: email, locale, userId, logMetadata: { purpose: 'deletion-scheduled' },
      data: { executeAfter: minute(notice.executeAfter), link: this.mail.link(locale, this.links.deletionCancel, { 'cancel-deletion': notice.ticket }) },
    });
    if (!result.success) throw new Error('Deletion notice delivery failed');
  }
  async twoFactorReset(email: string, locale: string, userId: string): Promise<void> {
    if (!this.mail.isEnabled()) return;
    const result = await this.mail.send(MAIL_TEMPLATE_KEYS.twoFactorReset, {
      to: email, locale, userId, logMetadata: { purpose: 'two-factor-reset' }, data: { link: this.mail.link(locale, this.links.twoFactorReset) },
    });
    if (!result.success) throw new Error('Two-factor reset notice delivery failed');
  }
  /**
   * Sent without a user id; afterwards (also on failure) its delivery-log rows are removed so the
   * erased address is not retained. Cleanup failure is logged, never thrown.
   */
  async deletionCompleted(email: string, locale: string): Promise<void> {
    if (!this.mail.isEnabled()) return;
    try {
      const result = await this.mail.send(MAIL_TEMPLATE_KEYS.deletionCompleted, { to: email, locale, data: {} });
      if (!result.success) throw new Error('Deletion confirmation delivery failed');
    } finally {
      await this.mail.forgetRecipient(email, MAIL_TEMPLATE_KEYS.deletionCompleted)
        .catch(() => this.logger.warn('Deletion notice log cleanup failed'));
    }
  }
}
