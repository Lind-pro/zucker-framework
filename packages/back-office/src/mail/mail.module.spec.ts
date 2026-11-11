import { describe, expect, it } from 'vitest';
import { Injectable, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DATABASE_ADAPTER } from '@zucker-framework/core';
import { InMemoryAdapter } from '@zucker-framework/crud';
import { MailService } from '@zucker-framework/notification';
import {
  BackOfficeMailModule, BackOfficeMailTransport, MAIL_ACCOUNT_MAILER, SMTP_PRESETS, TransactionalMail,
  mailSettingsFromConnection, type AccountMailerPort, type MailSettings, type MailSettingsSource,
} from '@zucker-framework/back-office/mail';

let current: MailSettings = mailSettingsFromConnection({});
@Injectable()
class SyntheticSettings implements MailSettingsSource { now() { return current; } }

/** Smoke: the global mail host compiles over a consumer settings source and selects transports per send. */
describe('BackOfficeMailModule', () => {
  it('wires MailService, transactional mail and the account mailer', async () => {
    const database = new InMemoryAdapter();
    @Module({
      imports: [
        { module: class DatabaseModule {}, global: true, providers: [{ provide: DATABASE_ADAPTER, useValue: database }], exports: [DATABASE_ADAPTER] },
        BackOfficeMailModule.forRoot({ settings: SyntheticSettings, site: { webUrl: 'https://app.example.invalid', siteName: 'Synthetic' },
          features: { admin: false }, localePrefix: false }),
      ],
    })
    class RootModule {}
    const app = await NestFactory.createApplicationContext(RootModule, { logger: false });
    const mail = app.get(TransactionalMail);
    expect(app.get(MailService).isMailEnabled()).toBe(false);
    expect(mail.isEnabled()).toBe(false);
    expect(() => app.get<AccountMailerPort>(MAIL_ACCOUNT_MAILER).assertConfigured()).toThrow('not configured');
    expect(mail.link('zh-CN', '/verify-email', { ticket: 't' })).toBe('https://app.example.invalid/verify-email#ticket=t');
    current = mailSettingsFromConnection({ MAIL_PROVIDER: 'cloudflare', SMTP_FROM: 'noreply@example.invalid', SMTP_PASSWORD: 'synthetic' }, SMTP_PRESETS);
    expect(current.smtp).toMatchObject({ host: 'smtp.mx.cloudflare.net', port: 465, secure: true, user: 'api_token' });
    expect(app.get(BackOfficeMailTransport).name).toBe('SMTP');
    expect(mail.isEnabled()).toBe(true);
    current = mailSettingsFromConnection({ MAIL_PROVIDER: 'resend', SMTP_FROM: 'noreply@example.invalid', MAIL_RESEND_API_KEY: 're_synthetic' });
    expect(app.get(BackOfficeMailTransport).name).toBe('Resend');
    await app.close();
  });
});
