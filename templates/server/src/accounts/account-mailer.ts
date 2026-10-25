import { Injectable, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import { EmailProvider } from '@zucker-framework/notification';
import type { AccountMailer } from './account.service';

/** Template-owned account message text; transport is the shared notification provider. */
@Injectable()
export class SmtpAccountMailer implements AccountMailer, OnModuleDestroy {
  private readonly provider: EmailProvider;
  private readonly from: string;
  private readonly webUrl: string;
  constructor(environment: NodeJS.ProcessEnv = process.env) {
    this.from = environment.SMTP_FROM ?? '';
    this.webUrl = environment.WEB_URL ?? '';
    this.provider = new EmailProvider({
      host: environment.SMTP_HOST ?? '', port: Number(environment.SMTP_PORT ?? 587),
      secure: environment.SMTP_SECURE === 'true', from: this.from,
      auth: { user: environment.SMTP_USER ?? '', pass: environment.SMTP_PASSWORD ?? '' },
    });
  }
  assertConfigured(): void {
    if (!this.provider.isConfigured() || !this.from || !this.webUrl) {
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
    const result = await this.provider.deliver({ to: email,
      subject: purpose === 'verify-email' ? 'Verify your email' : 'Reset your password',
      text: `${purpose === 'verify-email' ? 'Verify your email' : 'Reset your password'} using this link (valid for 30 minutes):\n${link.href}`,
    });
    if (!result.success) throw new ServiceUnavailableException('Account email delivery failed; request a new link');
  }
  async onModuleDestroy(): Promise<void> { await this.provider.close(); }
}
