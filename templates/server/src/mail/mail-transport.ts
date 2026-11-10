import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import {
  ResendEmailProvider, type MailDeliveryContext, type MailProvider, type SendMailOptions, type SendMailResult,
} from '@zucker-framework/notification';
import type { SmtpTransport } from './smtp-transport';

export type MailTransportKind = 'smtp' | 'resend';
export const MAIL_TRANSPORT_KINDS: readonly MailTransportKind[] = ['smtp', 'resend'];
export interface MailTransportSettings { kind: MailTransportKind; from: string; resendApiKey: string }

/**
 * Reads the transport choice of the `account-email` connection profile. `MAIL_PROVIDER` defaults to
 * `smtp` (the only transport before it existed); the sender address is `SMTP_FROM` for both kinds.
 * An unknown value is treated as unconfigured rather than silently falling back to SMTP.
 */
export function mailTransportSettingsFromConnection(environment: Readonly<NodeJS.ProcessEnv>): MailTransportSettings | null {
  const raw = environment.MAIL_PROVIDER?.trim() || 'smtp';
  if (!MAIL_TRANSPORT_KINDS.includes(raw as MailTransportKind)) return null;
  return { kind: raw as MailTransportKind, from: environment.SMTP_FROM?.trim() ?? '', resendApiKey: environment.MAIL_RESEND_API_KEY ?? '' };
}

/**
 * The application's one outbound mail transport for account and transactional mail (MailService).
 * It delegates to the shared `SmtpTransport` or to Resend, chosen from the resolved connection
 * settings on each use; the Resend client is rebuilt only when its settings change.
 */
@Injectable()
export class ApplicationMailTransport implements MailProvider, OnModuleDestroy {
  readonly supportsIdempotency = false;
  private resend: { key: string; provider: ResendEmailProvider } | null = null;
  private closed = false;
  constructor(private readonly smtp: SmtpTransport, private readonly resolve: () => MailTransportSettings | null) {}

  get name(): string { return this.resolve()?.kind === 'resend' ? 'Resend' : this.smtp.name; }
  private current(): MailProvider | null {
    if (this.closed) return null;
    const settings = this.resolve();
    if (!settings) return null;
    if (settings.kind === 'smtp') return this.smtp;
    const key = JSON.stringify([settings.from, settings.resendApiKey]);
    if (this.resend?.key !== key) {
      const previous = this.resend?.provider;
      this.resend = { key, provider: new ResendEmailProvider({ apiKey: settings.resendApiKey || undefined, from: settings.from }) };
      void previous?.close();
    }
    return settings.from ? this.resend.provider : null;
  }
  /** Sender address of the current settings. */
  get from(): string { return this.resolve()?.from ?? ''; }
  isConfigured(): boolean { return this.current()?.isConfigured() ?? false; }
  deliver(options: SendMailOptions, context?: MailDeliveryContext): Promise<SendMailResult> {
    const provider = this.current();
    if (!provider) return Promise.resolve({ success: false, error: 'Mail transport is not configured' });
    return provider.deliver(options, context);
  }
  async close(): Promise<void> {
    this.closed = true;
    await this.resend?.provider.close();
    // The SMTP transport is a separate provider with its own lifecycle (SmtpTransportModule).
  }
  async onModuleDestroy(): Promise<void> { await this.close(); }
}
