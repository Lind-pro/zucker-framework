import { Inject, Injectable, Module, Optional, RequestMethod, type MiddlewareConsumer, type NestModule, type OnModuleDestroy } from '@nestjs/common';
import {
  EmailProvider, type MailDeliveryContext, type MailProvider, type SendMailOptions, type SendMailResult,
} from '@zucker-framework/notification';
import { ConnectionSettingsService } from '../runtime-settings/connection-settings.service';
import { HotProvider } from '../runtime-settings/hot-apply';
import { RUNTIME_ENVIRONMENT } from '../runtime-settings/runtime-settings.tokens';
import {
  ApplicationMailTransport, LeasedProvider, mailTransportSettingsFromConnection, smtpSettingsFromConnection, type MailTransportSettings, type SmtpSettings,
} from './mail-transport';

export { smtpSettingsFromConnection, type SmtpSettings } from './mail-transport';

/** The runtime connection profile (runtime-settings descriptors) that configures this transport. */
export const SMTP_CONNECTION_PROFILE = 'account-email';

/**
 * The application's one SMTP transport. MailService (account and transactional mail) reaches it through
 * ApplicationMailTransport when `MAIL_PROVIDER` is `smtp`. It resolves its settings through `resolve`
 * on every use and builds a new underlying provider when they change. A send keeps the provider it
 * started with; a replaced provider is closed only after its last in-flight send settles.
 */
@Injectable()
export class SmtpTransport implements MailProvider, OnModuleDestroy {
  readonly name = 'SMTP';
  readonly supportsIdempotency = false;
  private readonly providers = new LeasedProvider<EmailProvider>(provider => provider.close());
  private closed = false;
  constructor(private readonly resolve: () => SmtpSettings, private readonly prepare?: () => Promise<unknown>) {}

  private provider(): EmailProvider {
    const settings = this.resolve();
    return this.providers.current(JSON.stringify(settings), () => new EmailProvider({ enabled: !!settings.host, host: settings.host, port: settings.port,
      secure: settings.secure, from: settings.from, auth: { user: settings.user, pass: settings.password } }));
  }
  /** Sender address of the current settings. */
  get from(): string { return this.resolve().from; }
  isConfigured(): boolean { return !this.closed && !!this.from && this.provider().isConfigured(); }
  async deliver(options: SendMailOptions, context?: MailDeliveryContext): Promise<SendMailResult> {
    if (this.closed) return { success: false, error: 'SMTP transport is closed' };
    await this.prepare?.();
    if (this.closed) return { success: false, error: 'SMTP transport is closed' };
    return this.providers.lease(this.provider(), provider => provider.deliver(options, context));
  }
  async close(): Promise<void> {
    this.closed = true;
    await this.providers.close();
  }
  async onModuleDestroy(): Promise<void> { await this.close(); }
}

/** Parsed `account-email` profile: the transport choice and the SMTP settings (plain data, no clients). */
export interface MailConnectionSettings { readonly transport: MailTransportSettings | null; readonly smtp: SmtpSettings }
/** Hot provider of the parsed `account-email` profile (`applyMode: 'hot'`). */
export const MAIL_CONNECTION = Symbol('MAIL_CONNECTION');
export type MailConnection = HotProvider<MailConnectionSettings>;
export function createMailConnection(settings?: ConnectionSettingsService, environment?: Readonly<NodeJS.ProcessEnv>): Promise<MailConnection> {
  return HotProvider.create<MailConnectionSettings>(settings, environment, {
    name: 'Account mail transport', profiles: [SMTP_CONNECTION_PROFILE],
    build: env => Object.freeze({ transport: mailTransportSettingsFromConnection(env), smtp: smtpSettingsFromConnection(env) }),
  }).ready();
}

/**
 * Provides the shared SmtpTransport and the selecting ApplicationMailTransport (SMTP or Resend, from
 * `MAIL_PROVIDER`) over the hot `account-email` profile (the fixed environment when runtime settings
 * are absent). Every request is pinned to one revision of the profile, so the mail a request sends
 * uses the settings that were current when it started; job workers pick up a save on their next send.
 */
@Module({
  providers: [
    { provide: MAIL_CONNECTION, inject: [{ token: ConnectionSettingsService, optional: true }, { token: RUNTIME_ENVIRONMENT, optional: true }],
      useFactory: (settings?: ConnectionSettingsService, environment?: Readonly<NodeJS.ProcessEnv>) => createMailConnection(settings, environment) },
    { provide: SmtpTransport, inject: [MAIL_CONNECTION],
      useFactory: (mail: MailConnection) => new SmtpTransport(() => mail.now().smtp, () => mail.current()) },
    { provide: ApplicationMailTransport, inject: [SmtpTransport, MAIL_CONNECTION],
      useFactory: (smtp: SmtpTransport, mail: MailConnection) => new ApplicationMailTransport(smtp, () => mail.now().transport, () => mail.current()) },
  ],
  exports: [SmtpTransport, ApplicationMailTransport, MAIL_CONNECTION],
})
export class SmtpTransportModule implements NestModule, OnModuleDestroy {
  constructor(@Optional() @Inject(MAIL_CONNECTION) private readonly mail?: MailConnection) {}
  configure(consumer: MiddlewareConsumer): void {
    // Mail can be sent from any route (sign-up, reset, billing, ...): pin the profile per request.
    if (this.mail) consumer.apply(this.mail.middleware()).forRoutes({ path: '{*splat}', method: RequestMethod.ALL });
  }
  async onModuleDestroy(): Promise<void> { await this.mail?.close(); }
}
