import { describe, expect, it } from 'vitest';
import { ApplicationMailTransport, MAIL_TRANSPORT_KINDS, mailTransportSettingsFromConnection, type MailTransportSettings } from '../src/mail/mail-transport';
import { SmtpTransport, smtpSettingsFromConnection } from '../src/mail/smtp-transport';
import { ACCOUNT_EMAIL_CONNECTION_PROFILE } from '../src/mail/mail.profiles';
import { ACCOUNT_MAIL_TEMPLATES, defaultMailSubject, mailLocale, MAIL_TEMPLATE_KEYS } from '../src/mail/mail-templates';
import { connectionSdkAvailable } from '../src/runtime-settings/connection-sdk';

/** Pure checks of transport selection, the account-email profile validation and the template catalogue. No network. */
describe('mailTransportSettingsFromConnection', () => {
  it('defaults to smtp, reads the sender from SMTP_FROM for both kinds, and trims', () => {
    expect(mailTransportSettingsFromConnection({})).toEqual({ kind: 'smtp', from: '', resendApiKey: '' });
    expect(mailTransportSettingsFromConnection({ MAIL_PROVIDER: ' resend ', SMTP_FROM: ' a@example.invalid ', MAIL_RESEND_API_KEY: 're_synthetic' }))
      .toEqual({ kind: 'resend', from: 'a@example.invalid', resendApiKey: 're_synthetic' });
    expect(MAIL_TRANSPORT_KINDS).toEqual(['smtp', 'resend']);
  });
  it('treats an unknown provider as unconfigured instead of falling back to SMTP', () => {
    for (const provider of ['sendgrid', 'RESEND', 'smtp2', 'ses']) expect(mailTransportSettingsFromConnection({ MAIL_PROVIDER: provider })).toBeNull();
  });
});

describe('ApplicationMailTransport selection', () => {
  const smtp = () => new SmtpTransport(() => smtpSettingsFromConnection({ SMTP_HOST: '127.0.0.1', SMTP_PORT: '1', SMTP_FROM: 'smtp@example.invalid' }));
  const make = (settings: () => MailTransportSettings | null) => new ApplicationMailTransport(smtp(), settings);
  it('selects SMTP by default and Resend when configured, following the resolver on each call', async () => {
    let current: MailTransportSettings | null = { kind: 'smtp', from: 'smtp@example.invalid', resendApiKey: '' };
    const transport = make(() => current);
    expect(transport.name).toBe('SMTP');
    expect(transport.isConfigured()).toBe(true);
    current = { kind: 'resend', from: 'noreply@example.invalid', resendApiKey: 're_synthetic' };
    expect(transport.name).toBe('Resend'); expect(transport.isConfigured()).toBe(true); expect(transport.from).toBe('noreply@example.invalid');
    current = { kind: 'resend', from: 'noreply@example.invalid', resendApiKey: '' };
    expect(transport.isConfigured()).toBe(false); // no API key
    current = { kind: 'resend', from: '', resendApiKey: 're_synthetic' };
    expect(transport.isConfigured()).toBe(false); // no sender
    current = null;
    expect(transport.isConfigured()).toBe(false); expect(transport.from).toBe('');
    await transport.close();
  });
  it('refuses to deliver when unconfigured or closed without touching any provider', async () => {
    const transport = make(() => null);
    await expect(transport.deliver({ to: 'a@example.invalid', subject: 's', html: '<p>x</p>' })).resolves.toMatchObject({ success: false });
    const open = make(() => ({ kind: 'resend', from: 'a@example.invalid', resendApiKey: 'k' }));
    await open.close();
    expect(open.isConfigured()).toBe(false);
    await expect(open.deliver({ to: 'a@example.invalid', subject: 's', html: '<p>x</p>' })).resolves.toMatchObject({ success: false });
  });
  it('does not claim idempotent delivery (the MailService log, not the provider, deduplicates)', () => {
    expect(make(() => null).supportsIdempotency).toBe(false);
  });
});

describe('account-email connection profile validation', () => {
  const validate = (env: Record<string, string>) => ACCOUNT_EMAIL_CONNECTION_PROFILE.validate!(env as NodeJS.ProcessEnv);
  it('is restart-applied and exposes MAIL_PROVIDER and the resend key (secret) among its fields', () => {
    expect(ACCOUNT_EMAIL_CONNECTION_PROFILE.applyMode).toBe('restart');
    const fields = ACCOUNT_EMAIL_CONNECTION_PROFILE.profile.fields;
    expect(fields.find(field => field.key === 'MAIL_PROVIDER')).toMatchObject({ type: 'select', options: ['smtp', 'resend'] });
    expect(fields.find(field => field.key === 'MAIL_RESEND_API_KEY')).toMatchObject({ type: 'secret' });
    expect(fields.find(field => field.key === 'SMTP_PASSWORD')).toMatchObject({ type: 'secret' });
  });
  it('accepts an empty smtp profile (mail is simply off) and a complete one', async () => {
    await expect(validate({})).resolves.toBeUndefined();
    await expect(validate({ SMTP_HOST: 'smtp.example.invalid', SMTP_FROM: 'a@example.invalid', WEB_URL: 'https://app.example.invalid' })).resolves.toBeUndefined();
  });
  it.each([
    ['unknown provider', { MAIL_PROVIDER: 'ses' }],
    ['smtp host without sender', { SMTP_HOST: 'smtp.example.invalid', WEB_URL: 'https://app.example.invalid' }],
    ['smtp sender without host', { SMTP_FROM: 'a@example.invalid', WEB_URL: 'https://app.example.invalid' }],
    ['smtp without WEB_URL', { SMTP_HOST: 'smtp.example.invalid', SMTP_FROM: 'a@example.invalid' }],
    ['smtp port 0', { SMTP_HOST: 'h.example.invalid', SMTP_FROM: 'a@example.invalid', SMTP_PORT: '0', WEB_URL: 'https://app.example.invalid' }],
    ['smtp port 70000', { SMTP_HOST: 'h.example.invalid', SMTP_FROM: 'a@example.invalid', SMTP_PORT: '70000', WEB_URL: 'https://app.example.invalid' }],
    ['smtp non-numeric port', { SMTP_HOST: 'h.example.invalid', SMTP_FROM: 'a@example.invalid', SMTP_PORT: 'abc', WEB_URL: 'https://app.example.invalid' }],
    ['smtp with a WEB_URL that is not an origin', { SMTP_HOST: 'h.example.invalid', SMTP_FROM: 'a@example.invalid', WEB_URL: 'https://app.example.invalid/path' }],
    ['resend without key', { MAIL_PROVIDER: 'resend', SMTP_FROM: 'a@example.invalid', WEB_URL: 'https://app.example.invalid' }],
    ['resend without sender', { MAIL_PROVIDER: 'resend', MAIL_RESEND_API_KEY: 're_x', WEB_URL: 'https://app.example.invalid' }],
    ['resend without WEB_URL', { MAIL_PROVIDER: 'resend', MAIL_RESEND_API_KEY: 're_x', SMTP_FROM: 'a@example.invalid' }],
  ])('rejects %s', async (_name, env) => {
    await expect(validate(env)).rejects.toThrow();
  });
  it('requires the resend SDK to be installed before a resend profile is accepted', async () => {
    const env = { MAIL_PROVIDER: 'resend', MAIL_RESEND_API_KEY: 're_x', SMTP_FROM: 'a@example.invalid', WEB_URL: 'https://app.example.invalid' };
    if (connectionSdkAvailable('@zucker-framework/notification', 'resend')) await expect(validate(env)).resolves.toBeUndefined();
    else await expect(validate(env)).rejects.toThrow('resend-sdk');
  });
  it('never echoes a secret in a validation failure', async () => {
    const failure = await validate({ MAIL_PROVIDER: 'resend', MAIL_RESEND_API_KEY: 're_SENTINELSECRET', WEB_URL: 'https://app.example.invalid' }).catch(error => error as Error);
    expect(String((failure as Error).message)).not.toContain('SENTINELSECRET');
  });
});

describe('built-in mail templates', () => {
  it('ships an English and a Chinese variant of every key, each declaring only its documented variables', () => {
    expect(ACCOUNT_MAIL_TEMPLATES.map(template => template.key).sort()).toEqual(Object.values(MAIL_TEMPLATE_KEYS).sort());
    for (const template of ACCOUNT_MAIL_TEMPLATES) {
      expect(Object.keys(template.contents).sort()).toEqual(['en', 'zh']);
      for (const html of Object.values(template.contents)) {
        const used = [...html!.matchAll(/\{\{(\w+)\}\}/g)].map(match => match[1]);
        for (const name of used) expect(`${template.description}`, `${template.key} documents ${name}`).toContain(name);
      }
    }
  });
  it('puts every URL variable in href position only (so the catalog restricts its scheme) and never in script or style', () => {
    for (const template of ACCOUNT_MAIL_TEMPLATES) for (const html of Object.values(template.contents)) {
      expect(html).not.toMatch(/<script/i);
      expect(html).not.toMatch(/on\w+\s*=/i);
      expect(html).not.toMatch(/(?:src|action|formaction)\s*=\s*"\{\{/i);
      expect(html).not.toMatch(/style="[^"]*\{\{/i);
    }
  });
  it('localises subjects and normalises locales', () => {
    expect(defaultMailSubject('account.verify', 'zh-CN')).toBe('验证你的邮箱');
    expect(defaultMailSubject('account.verify', 'zh_TW')).toBe('验证你的邮箱');
    expect(defaultMailSubject('billing.receipt', 'fr')).toBe('Your payment receipt');
    expect(defaultMailSubject('account.welcome', null)).toBe('Welcome aboard');
    expect([mailLocale('zh'), mailLocale('ZH'), mailLocale(undefined), mailLocale('')]).toEqual(['zh', 'en', 'en', 'en']);
  });
});
