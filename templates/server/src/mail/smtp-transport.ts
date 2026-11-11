import { Inject, Injectable, Module, Optional, RequestMethod, type MiddlewareConsumer, type NestModule, type OnModuleDestroy } from '@nestjs/common';
import { mailSettingsFromConnection, type MailSettings, type MailSettingsSource } from '@zucker-framework/back-office/mail';
import { ConnectionSettingsService } from '../runtime-settings/connection-settings.service';
import { HotProvider } from '@zucker-framework/back-office/settings';
import { RUNTIME_ENVIRONMENT } from '../runtime-settings/runtime-settings.tokens';

export { SmtpTransport, smtpSettingsFromConnection, type SmtpSettings } from '@zucker-framework/back-office/mail';

/** The runtime connection profile (runtime-settings descriptors) that configures the mail transport. */
export const SMTP_CONNECTION_PROFILE = 'account-email';

/** Parsed `account-email` profile: the transport choice and the SMTP settings (plain data, no clients). */
export type MailConnectionSettings = MailSettings;
/** Hot provider of the parsed `account-email` profile (`applyMode: 'hot'`). */
export const MAIL_CONNECTION = Symbol('MAIL_CONNECTION');
export type MailConnection = HotProvider<MailConnectionSettings>;
export function createMailConnection(settings?: ConnectionSettingsService, environment?: Readonly<NodeJS.ProcessEnv>): Promise<MailConnection> {
  return HotProvider.create<MailConnectionSettings>(settings, environment, {
    name: 'Account mail transport', profiles: [SMTP_CONNECTION_PROFILE],
    build: env => mailSettingsFromConnection(env),
  }).ready();
}

/** The back-office mail host reads its transport settings from the hot profile. */
@Injectable()
export class RuntimeMailSettings implements MailSettingsSource {
  constructor(@Inject(MAIL_CONNECTION) private readonly mail: MailConnection) {}
  now(): MailSettings { return this.mail.now(); }
  refresh(): Promise<unknown> { return this.mail.current(); }
}

/**
 * The hot `account-email` profile (the fixed environment when runtime settings are absent). Every
 * request is pinned to one revision of the profile, so the mail a request sends uses the settings that
 * were current when it started; job workers pick up a save on their next send (`refresh`).
 */
@Module({
  providers: [
    { provide: MAIL_CONNECTION, inject: [{ token: ConnectionSettingsService, optional: true }, { token: RUNTIME_ENVIRONMENT, optional: true }],
      useFactory: (settings?: ConnectionSettingsService, environment?: Readonly<NodeJS.ProcessEnv>) => createMailConnection(settings, environment) },
  ],
  exports: [MAIL_CONNECTION],
})
export class SmtpTransportModule implements NestModule, OnModuleDestroy {
  constructor(@Optional() @Inject(MAIL_CONNECTION) private readonly mail?: MailConnection) {}
  configure(consumer: MiddlewareConsumer): void {
    // Mail can be sent from any route (sign-up, reset, billing, ...): pin the profile per request.
    if (this.mail) consumer.apply(this.mail.middleware()).forRoutes({ path: '{*splat}', method: RequestMethod.ALL });
  }
  async onModuleDestroy(): Promise<void> { await this.mail?.close(); }
}
