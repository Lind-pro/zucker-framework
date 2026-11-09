import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { SmtpTransport } from '../mail/smtp-transport';
import type { AccountMailer } from './account.service';

/** Template-owned account message text; transport is the application's shared SMTP transport. */
@Injectable()
export class SmtpAccountMailer implements AccountMailer {
  constructor(private readonly transport: SmtpTransport, private readonly webUrl: string) {}
  assertConfigured(): void {
    if (!this.transport.isConfigured() || !this.webUrl) {
      throw new ServiceUnavailableException('Account email is not configured');
    }
  }
  async send(email: string, purpose: 'verify-email' | 'reset-password', ticket: string, locale: string): Promise<void> {
    this.assertConfigured();
    const base = new URL(this.webUrl);
    if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password) throw new ServiceUnavailableException('Invalid account site URL');
    const link = new URL(`/${locale === 'zh' ? 'zh' : 'en'}/${purpose}`, base);
    // Keep bearer tickets out of HTTP access logs and referrers; the page reads the fragment.
    link.hash = new URLSearchParams({ ticket }).toString();
    const result = await this.transport.deliver({ to: email,
      subject: purpose === 'verify-email' ? 'Verify your email' : 'Reset your password',
      text: `${purpose === 'verify-email' ? 'Verify your email' : 'Reset your password'} using this link (valid for 30 minutes):\n${link.href}`,
    });
    if (!result.success) throw new ServiceUnavailableException('Account email delivery failed; request a new link');
  }
}
