import { Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import {
  EmailProvider, type MailDeliveryContext, type MailProvider, type SendMailOptions, type SendMailResult,
} from '@zucker-framework/notification';
import { RUNTIME_ENVIRONMENT } from '../runtime-settings/runtime-settings.tokens';

/** The runtime connection profile (runtime-settings descriptors) that configures this transport. */
export const SMTP_CONNECTION_PROFILE = 'account-email';

export interface SmtpSettings { host: string; port: number; secure: boolean; from: string; user: string; password: string }

/** Reads the `account-email` connection fields from a resolved runtime environment. */
export function smtpSettingsFromConnection(environment: Readonly<NodeJS.ProcessEnv>): SmtpSettings {
  return { host: environment.SMTP_HOST?.trim() ?? '', port: Number(environment.SMTP_PORT ?? 587),
    secure: environment.SMTP_SECURE === 'true', from: environment.SMTP_FROM?.trim() ?? '',
    user: environment.SMTP_USER ?? '', password: environment.SMTP_PASSWORD ?? '' };
}

/**
 * The application's one SMTP transport, shared by account mail and MailService. It resolves its
 * settings through `resolve` on use and rebuilds the underlying provider only when they change, so
 * the runtime-settings hot-reload work (RuntimeProviderSlot) only has to supply a live resolver.
 */
@Injectable()
export class SmtpTransport implements MailProvider, OnModuleDestroy {
  readonly name = 'SMTP';
  readonly supportsIdempotency = false;
  private current: { key: string; provider: EmailProvider } | null = null;
  private closed = false;
  constructor(private readonly resolve: () => SmtpSettings) {}

  private provider(): EmailProvider {
    const settings = this.resolve();
    const key = JSON.stringify(settings);
    if (this.current?.key !== key) {
      const previous = this.current?.provider;
      this.current = { key, provider: new EmailProvider({ enabled: !!settings.host, host: settings.host, port: settings.port,
        secure: settings.secure, from: settings.from, auth: { user: settings.user, pass: settings.password } }) };
      void previous?.close();
    }
    return this.current.provider;
  }
  /** Sender address of the current settings. */
  get from(): string { return this.resolve().from; }
  isConfigured(): boolean { return !this.closed && !!this.from && this.provider().isConfigured(); }
  deliver(options: SendMailOptions, context?: MailDeliveryContext): Promise<SendMailResult> {
    if (this.closed) return Promise.resolve({ success: false, error: 'SMTP transport is closed' });
    return this.provider().deliver(options, context);
  }
  async close(): Promise<void> {
    this.closed = true;
    await this.current?.provider.close();
  }
  async onModuleDestroy(): Promise<void> { await this.close(); }
}

/** Provides the shared SmtpTransport from the runtime connection settings (environment when absent). */
@Module({
  providers: [{ provide: SmtpTransport, inject: [{ token: RUNTIME_ENVIRONMENT, optional: true }],
    useFactory: (environment?: Readonly<NodeJS.ProcessEnv>) => new SmtpTransport(() => smtpSettingsFromConnection(environment ?? process.env)) }],
  exports: [SmtpTransport],
})
export class SmtpTransportModule {}
