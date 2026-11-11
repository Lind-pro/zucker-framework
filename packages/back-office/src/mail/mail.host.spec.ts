// @vitest-environment node
import { Injectable, Module, NotFoundException, ServiceUnavailableException, type INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DATABASE_ADAPTER } from '@zucker-framework/core';
import { InMemoryAdapter } from '@zucker-framework/crud';
import { MailService } from '@zucker-framework/notification';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ACCOUNT_MAIL_TEMPLATES, BACK_OFFICE_MAIL_TEMPLATES, BackOfficeAccountMailer, BackOfficeMailModule, BackOfficeMailTransport, LeasedProvider,
  MAIL_ACCOUNT_MAILER, MAIL_TEMPLATE_KEYS, SMTP_PRESETS, SmtpTransport, TransactionalMail, VERIFICATION_CODE_MAIL_KEY,
  VERIFICATION_CODE_MAIL_TEMPLATE, mailSettingsFromConnection, resolveMailOptions, seedMailTemplates, smtpSettingsFromPreset,
  type BackOfficeMailOptions, type MailSettings, type MailSettingsSource,
} from './index';

const SMTP_ENV = { SMTP_HOST: 'smtp.example.invalid', SMTP_FROM: 'noreply@example.invalid', SMTP_PASSWORD: 'synthetic' };
let current: MailSettings = mailSettingsFromConnection(SMTP_ENV);
@Injectable()
class Settings implements MailSettingsSource { now() { return current; } }

/** In-memory database whose template `key` is unique like the real table (the claim is synchronous, so racing inserts really conflict). */
class UniqueTemplateKeys extends InMemoryAdapter {
  private readonly keys = new Set<string>();
  override model(name: string) {
    const operations = super.model(name);
    if (name !== 'emailTemplates') return operations;
    return new Proxy(operations, { get: (target, property) => property !== 'create' ? Reflect.get(target, property, target) : async (args: { data: { key: string } }) => {
      if (this.keys.has(args.data.key)) throw new Error('Unique constraint failed on the fields: (`key`)');
      this.keys.add(args.data.key);
      return target.create(args as never);
    } });
  }
}
const apps: INestApplicationContext[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); current = mailSettingsFromConnection(SMTP_ENV); });

/** The mail host over an in-memory database; the SMTP transport's `deliver` is replaced by a recorder. */
async function boot(options: BackOfficeMailOptions = {}, { sendOk = true, configured = true } = {}) {
  const database = new UniqueTemplateKeys();
  @Module({
    imports: [
      { module: class DatabaseModule {}, global: true, providers: [{ provide: DATABASE_ADAPTER, useValue: database }], exports: [DATABASE_ADAPTER] },
      BackOfficeMailModule.forRoot({ settings: configured ? Settings : undefined, site: { webUrl: 'https://app.example.invalid', siteName: 'Synthetic' },
        features: { admin: false }, delivery: { minimumIntervalMs: 0, maxRetries: 0 }, ...options }),
    ],
  })
  class RootModule {}
  const app = await NestFactory.createApplicationContext(RootModule, { logger: false });
  apps.push(app);
  const sent: Array<{ to: unknown; subject: string; html: string }> = [];
  vi.spyOn(app.get(SmtpTransport), 'deliver').mockImplementation(async options => {
    sent.push({ to: options.to, subject: options.subject, html: String(options.html) });
    return sendOk ? { success: true } : { success: false, error: 'Synthetic delivery failure' };
  });
  return { app, database, sent, mail: app.get(TransactionalMail), mailer: (options.features?.accountMailer === false ? undefined : app.get<BackOfficeAccountMailer>(MAIL_ACCOUNT_MAILER)) as BackOfficeAccountMailer };
}

describe('mail settings parsing: provider selection and presets', () => {
  it('defaults to SMTP and reads host fields from the environment', () => {
    const settings = mailSettingsFromConnection({ SMTP_HOST: ' h.example.invalid ', SMTP_PORT: '2525', SMTP_SECURE: 'true', SMTP_FROM: ' a@example.invalid ', SMTP_USER: 'u', SMTP_PASSWORD: 'p' });
    expect(settings.transport).toEqual({ kind: 'smtp', from: 'a@example.invalid', resendApiKey: '' });
    expect(settings.smtp).toEqual({ host: 'h.example.invalid', port: 2525, secure: true, from: 'a@example.invalid', user: 'u', password: 'p' });
    expect(mailSettingsFromConnection({}).smtp).toMatchObject({ host: '', port: 587, secure: false });
  });
  it('selects resend and carries its key; an unknown provider is unconfigured, never a silent SMTP fallback', () => {
    expect(mailSettingsFromConnection({ MAIL_PROVIDER: 'resend', MAIL_RESEND_API_KEY: 're_x', SMTP_FROM: 'a@example.invalid' }).transport)
      .toEqual({ kind: 'resend', from: 'a@example.invalid', resendApiKey: 're_x' });
    expect(mailSettingsFromConnection({ MAIL_PROVIDER: 'carrier-pigeon' }).transport).toBeNull();
    // Presets only count when the caller passes them.
    expect(mailSettingsFromConnection({ MAIL_PROVIDER: 'sendgrid' }).transport).toBeNull();
    // Prototype keys are not presets.
    for (const name of ['__proto__', 'toString', 'constructor', 'hasOwnProperty'])
      expect(mailSettingsFromConnection({ MAIL_PROVIDER: name }, SMTP_PRESETS).transport).toBeNull();
  });
  it.each([
    ['cloudflare', { host: 'smtp.mx.cloudflare.net', port: 465, secure: true, user: 'api_token' }],
    ['resend-smtp', { host: 'smtp.resend.com', port: 465, secure: true, user: 'resend' }],
    ['sendgrid', { host: 'smtp.sendgrid.net', port: 587, secure: false, user: 'apikey' }],
    ['mailgun', { host: 'smtp.mailgun.org', port: 587, secure: false, user: '' }],
    ['postmark', { host: 'smtp.postmarkapp.com', port: 587, secure: false, user: '' }],
    ['gmail', { host: 'smtp.gmail.com', port: 465, secure: true, user: '' }],
    ['office365', { host: 'smtp.office365.com', port: 587, secure: false, user: '' }],
  ])('preset %s fills host, port, TLS and user; explicit environment values win; blanks do not', (name, expected) => {
    const base = mailSettingsFromConnection({ MAIL_PROVIDER: name, SMTP_FROM: 'a@example.invalid', SMTP_PASSWORD: 'p' }, SMTP_PRESETS);
    expect(base.transport).toMatchObject({ kind: 'smtp' });
    expect(base.smtp).toMatchObject(expected);
    const blank = mailSettingsFromConnection({ MAIL_PROVIDER: name, SMTP_HOST: '  ', SMTP_PORT: '', SMTP_SECURE: ' ', SMTP_USER: '' }, SMTP_PRESETS);
    expect(blank.smtp).toMatchObject(expected);
    const override = mailSettingsFromConnection({ MAIL_PROVIDER: name, SMTP_HOST: 'relay.example.invalid', SMTP_PORT: '25', SMTP_SECURE: 'false', SMTP_USER: 'me' }, SMTP_PRESETS);
    expect(override.smtp).toMatchObject({ host: 'relay.example.invalid', port: 25, secure: false, user: 'me' });
  });
  it('smtpSettingsFromPreset validates the preset, the sender and the port', () => {
    expect(smtpSettingsFromPreset('sendgrid', { from: ' a@example.invalid ', password: 'p' })).toEqual({ host: 'smtp.sendgrid.net', port: 587, secure: false, from: 'a@example.invalid', user: 'apikey', password: 'p' });
    expect(smtpSettingsFromPreset('gmail', { from: 'a@example.invalid', password: 'p', port: 587, secure: false, user: 'me', host: 'x.invalid' }))
      .toMatchObject({ host: 'x.invalid', port: 587, secure: false, user: 'me' });
    expect(() => smtpSettingsFromPreset('nope', { from: 'a', password: 'p' })).toThrow(/unknown SMTP preset/);
    expect(() => smtpSettingsFromPreset('__proto__', { from: 'a', password: 'p' })).toThrow(/unknown SMTP preset/);
    expect(() => smtpSettingsFromPreset('gmail', { from: 'a@example.invalid\r\nBcc: x@example.invalid', password: 'p' })).toThrow(/single line/);
    for (const port of [0, 70000, 1.5, Number.NaN]) expect(() => smtpSettingsFromPreset('gmail', { from: 'a', password: 'p', port })).toThrow(/port/);
    expect(() => smtpSettingsFromPreset('custom', { from: 'a', password: 'p' }, { custom: { host: 'c.invalid', port: 25, secure: false } })).not.toThrow();
  });
  it('presets are frozen', () => {
    expect(Object.isFrozen(SMTP_PRESETS) && Object.isFrozen(SMTP_PRESETS.cloudflare)).toBe(true);
  });
});

describe('LeasedProvider', () => {
  it('builds per key and closes a replaced client only after its last lease ends', async () => {
    const closed: string[] = [];
    const leased = new LeasedProvider<{ id: string }>(provider => { closed.push(provider.id); });
    const a = leased.current('a', () => ({ id: 'a' }));
    expect(leased.current('a', () => ({ id: 'never' }))).toBe(a);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const inflight = leased.lease(a, async () => { await gate; return 'done'; });
    const b = leased.current('b', () => ({ id: 'b' }));
    expect(b).not.toBe(a);
    await Promise.resolve();
    expect(closed).toEqual([]);
    release();
    expect(await inflight).toBe('done');
    expect(closed).toEqual(['a']);
    await leased.close();
    expect(closed).toEqual(['a', 'b']);
  });
  it('a failing dispose never fails the send', async () => {
    const leased = new LeasedProvider<{ id: string }>(() => { throw new Error('boom'); });
    const a = leased.current('a', () => ({ id: 'a' }));
    leased.current('b', () => ({ id: 'b' }));
    await expect(leased.lease(a, async () => 1)).resolves.toBe(1);
  });
});

describe('BackOfficeMailTransport', () => {
  it('switches provider per send, reports no transport when unconfigured, and refuses after close', async () => {
    const { app } = await boot();
    const transport = app.get(BackOfficeMailTransport);
    expect(transport.name).toBe('SMTP');
    current = mailSettingsFromConnection({ MAIL_PROVIDER: 'resend', MAIL_RESEND_API_KEY: 're_synthetic', SMTP_FROM: 'a@example.invalid' });
    expect(transport.name).toBe('Resend');
    expect(transport.isConfigured()).toBe(true);
    // Resend without a sender is not usable.
    current = mailSettingsFromConnection({ MAIL_PROVIDER: 'resend', MAIL_RESEND_API_KEY: 're_synthetic' });
    expect(transport.isConfigured()).toBe(false);
    expect(await transport.deliver({ to: 'x@example.invalid', subject: 's', html: 'h' })).toMatchObject({ success: false, error: expect.stringContaining('not configured') });
    current = mailSettingsFromConnection({ MAIL_PROVIDER: 'nope' });
    expect(transport.isConfigured()).toBe(false);
    await transport.close();
    current = mailSettingsFromConnection(SMTP_ENV);
    expect(await transport.deliver({ to: 'x@example.invalid', subject: 's', html: 'h' })).toMatchObject({ success: false });
  });
});

describe('transactional mail and templates', () => {
  it('falls back to the built-in template, then prefers a stored active row, and ignores an inactive one', async () => {
    const { mail, database, sent } = await boot();
    expect(mail.isEnabled()).toBe(true);
    await mail.send(MAIL_TEMPLATE_KEYS.welcome, { to: 'a@example.invalid', locale: 'zh-CN', data: { name: 'Ada <b>', link: 'https://app.example.invalid/x' } });
    expect(sent[0].subject).toBe('欢迎加入');
    expect(sent[0].html).toContain('欢迎你，Ada &lt;b&gt;');
    expect(sent[0].html).not.toContain('Ada <b>');
    await mail.send(MAIL_TEMPLATE_KEYS.welcome, { to: 'a@example.invalid', locale: 'fr', data: { name: 'Ada', link: 'https://app.example.invalid/x' } });
    expect(sent[1].subject).toBe('Welcome aboard');
    await database.model('emailTemplates').create({ data: { key: MAIL_TEMPLATE_KEYS.welcome, name: 'Custom', subject: 'Custom hello\r\nBcc: evil@example.invalid',
      htmlContentEn: '<p>Custom {{name}}</p>', htmlContentZh: null, isActive: true } });
    await mail.send(MAIL_TEMPLATE_KEYS.welcome, { to: 'a@example.invalid', locale: 'en', data: { name: 'Ada', link: 'https://app.example.invalid/x' } });
    expect(sent[2].html).toContain('Custom Ada');
    expect(sent[2].subject).not.toMatch(/[\r\n]/);
    expect(sent[2].subject).toMatch(/^Custom hello\s+Bcc: evil@example\.invalid$/);
    // Missing locale content falls back to the default locale of the stored row.
    await mail.send(MAIL_TEMPLATE_KEYS.welcome, { to: 'a@example.invalid', locale: 'zh', data: { name: 'Ada', link: 'https://app.example.invalid/x' } });
    expect(sent[3].html).toContain('Custom Ada');
    const row = await database.model('emailTemplates').findFirst!({ where: { key: MAIL_TEMPLATE_KEYS.welcome } }) as { id: string };
    await database.model('emailTemplates').update({ where: { id: row.id }, data: { isActive: false } });
    await mail.send(MAIL_TEMPLATE_KEYS.welcome, { to: 'a@example.invalid', locale: 'en', data: { name: 'Ada', link: 'https://app.example.invalid/x' } });
    expect(sent[4].html).toContain('Welcome, Ada');
    expect(sent[4].subject).toBe('Welcome aboard');
  });
  it('builds links on the configured origin only, with locale prefix and fragment', async () => {
    const withPrefix = await boot();
    expect(withPrefix.mail.link('zh-CN', '/verify-email', { ticket: 'a b' })).toBe('https://app.example.invalid/zh/verify-email#ticket=a+b');
    expect(withPrefix.mail.link('xx', '/account')).toBe('https://app.example.invalid/en/account');
    expect(() => withPrefix.mail.link('en', '//evil.example.invalid')).toThrow(/site-relative/);
    expect(() => withPrefix.mail.link('en', 'evil')).toThrow(/site-relative/);
    const plain = await boot({ localePrefix: false, links: { verifyEmail: '/v' } });
    expect(plain.mail.link('zh', plain.mail.options.links.verifyEmail, { ticket: 't' })).toBe('https://app.example.invalid/v#ticket=t');
  });
  it('is disabled without a transport and without a usable web URL, and rejects credentialed URLs', async () => {
    const none = await boot({}, { configured: false });
    expect(none.mail.isEnabled()).toBe(false);
    expect(none.mail.canSend()).toBe(false);
    const noSite = await boot({ site: { webUrl: null } });
    expect(noSite.mail.isEnabled()).toBe(false);
    expect(noSite.mail.canSend()).toBe(true);
    expect(() => noSite.mail.link('en', '/x')).toThrow(/web URL/);
    const credentialed = await boot({ site: { webUrl: 'https://user:pw@app.example.invalid' } });
    expect(credentialed.mail.isEnabled()).toBe(false);
    const wrongScheme = await boot({ site: { webUrl: 'javascript:alert(1)' } });
    expect(wrongScheme.mail.isEnabled()).toBe(false);
  });
});

describe('account mailer', () => {
  it('sends ticket links in the fragment and never logs the ticket', async () => {
    const { mailer, sent, database } = await boot();
    mailer.assertConfigured();
    await mailer.send('a@example.invalid', 'verify-email', 'TICKET123', 'en', 'u1');
    await mailer.send('a@example.invalid', 'reset-password', 'TICKET456', 'zh', 'u1');
    await mailer.send('a@example.invalid', 'magic-link', 'TICKET789', 'en', 'u1');
    expect(sent.map(mail => mail.subject)).toEqual(['Verify your email', '重置你的密码', 'Your sign-in link']);
    expect(sent[0].html).toContain('https://app.example.invalid/en/verify-email#ticket=TICKET123');
    expect(sent[1].html).toContain('https://app.example.invalid/zh/reset-password#ticket=TICKET456');
    const logs = JSON.stringify(await database.model('emailLogs').findMany({}));
    expect(logs).not.toMatch(/TICKET/);
    expect(logs).toContain('verify-email');
    await expect(mailer.send('a@example.invalid', 'nope' as never, 't', 'en')).rejects.toThrow(/Unsupported/);
  });
  it('answers 503 without a transport or web URL and when delivery fails', async () => {
    const none = await boot({}, { configured: false });
    expect(() => none.mailer.assertConfigured()).toThrow(ServiceUnavailableException);
    await expect(none.mailer.send('a@example.invalid', 'verify-email', 't', 'en')).rejects.toBeInstanceOf(ServiceUnavailableException);
    const noSite = await boot({ site: {} });
    expect(() => noSite.mailer.assertConfigured()).toThrow(ServiceUnavailableException);
    const failing = await boot({}, { sendOk: false });
    await expect(failing.mailer.send('a@example.invalid', 'verify-email', 't', 'en')).rejects.toBeInstanceOf(ServiceUnavailableException);
    // Notices are best effort: a plain error on failure, a no-op when disabled.
    await expect(failing.mailer.welcome('a@example.invalid', 'en', 'Ada', 'u1')).rejects.toThrow('Welcome mail delivery failed');
    await expect(none.mailer.welcome('a@example.invalid', 'en', 'Ada', 'u1')).resolves.toBeUndefined();
    await expect(none.mailer.deletionCompleted('a@example.invalid', 'en')).resolves.toBeUndefined();
  });
  it('code mail needs no web URL, carries the code and never logs it; 503 when disabled or the template is missing', async () => {
    const { mailer, sent, database } = await boot({ site: {}, templates: { builtIns: BACK_OFFICE_MAIL_TEMPLATES } });
    await mailer.code('a@example.invalid', 'login', '482913', 'zh', 'u1');
    expect(sent[0].subject).toBe('你的验证码');
    expect(sent[0].html).toContain('482913');
    expect(sent[0].html).toContain('15');
    await mailer.code('a@example.invalid', 'reset-password', '111222', 'en');
    expect(sent[1].subject).toBe('Your verification code');
    const logs = JSON.stringify(await database.model('emailLogs').findMany({}));
    expect(logs).not.toMatch(/482913|111222/);
    expect(logs).toContain('code:login');
    const none = await boot({ templates: { builtIns: BACK_OFFICE_MAIL_TEMPLATES } }, { configured: false });
    await expect(none.mailer.code('a@example.invalid', 'login', '123456', 'en')).rejects.toBeInstanceOf(ServiceUnavailableException);
    // With the account mailer on, the code template is added to the built-ins when none is configured.
    const defaults = await boot({ site: {} });
    await defaults.mailer.code('a@example.invalid', 'login', '123456', 'en');
    expect(defaults.sent).toHaveLength(1);
    // Any delivery failure, including a template the catalog cannot find, is a 503 and sends nothing.
    const failing = await boot({ site: {} }, { sendOk: false });
    await expect(failing.mailer.code('a@example.invalid', 'login', '123456', 'en')).rejects.toBeInstanceOf(ServiceUnavailableException);
    const missing = await boot({ site: {} });
    vi.spyOn(missing.mail, 'send').mockRejectedValueOnce(new NotFoundException('Template not found'));
    await expect(missing.mailer.code('a@example.invalid', 'login', '123456', 'en')).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(missing.sent).toHaveLength(0);
    expect(ACCOUNT_MAIL_TEMPLATES.map(item => item.key)).not.toContain(VERIFICATION_CODE_MAIL_KEY);
    expect(BACK_OFFICE_MAIL_TEMPLATES).toHaveLength(ACCOUNT_MAIL_TEMPLATES.length + 1);
  });
  it('deletion completed removes the recipient log rows, also when sending fails', async () => {
    const ok = await boot();
    await ok.mailer.deletionCompleted('gone@example.invalid', 'en');
    expect(ok.sent).toHaveLength(1);
    expect(await ok.database.model('emailLogs').count({ where: { recipient: 'gone@example.invalid' } })).toBe(0);
    const failing = await boot({}, { sendOk: false });
    await expect(failing.mailer.deletionCompleted('gone@example.invalid', 'en')).rejects.toThrow('Deletion confirmation delivery failed');
    expect(await failing.database.model('emailLogs').count({ where: { recipient: 'gone@example.invalid' } })).toBe(0);
  });
  it('registers the account mailer only when the feature is on', async () => {
    const off = await boot({ features: { admin: false, accountMailer: false } });
    expect(() => off.app.get(MAIL_ACCOUNT_MAILER)).toThrow();
    expect(() => off.app.get(BackOfficeAccountMailer)).toThrow();
  });
});

describe('template seeding', () => {
  it('stores missing built-ins once and never touches an existing row, even an inactive one', async () => {
    const { app, database } = await boot();
    const catalog = app.get(MailService).templates;
    await database.model('emailTemplates').create({ data: { key: MAIL_TEMPLATE_KEYS.verify, name: 'Mine', subject: 'Mine', htmlContentEn: '<p>mine</p>', isActive: false } });
    const first = await seedMailTemplates(catalog);
    expect(first.existing).toEqual([MAIL_TEMPLATE_KEYS.verify]);
    expect(first.created).toHaveLength(BACK_OFFICE_MAIL_TEMPLATES.length - 1);
    const second = await seedMailTemplates(catalog);
    expect(second.created).toEqual([]);
    expect(second.existing).toHaveLength(BACK_OFFICE_MAIL_TEMPLATES.length);
    const row = await database.model('emailTemplates').findFirst!({ where: { key: MAIL_TEMPLATE_KEYS.verify } }) as { name: string; isActive: boolean };
    expect(row).toMatchObject({ name: 'Mine', isActive: false });
    expect(await database.model('emailTemplates').count({})).toBe(BACK_OFFICE_MAIL_TEMPLATES.length);
    await expect(seedMailTemplates(catalog, ['no.such.key'])).rejects.toThrow(/Unknown built-in/);
  });
  it('two replicas seeding concurrently create each key exactly once and neither fails', async () => {
    const { app, database } = await boot();
    const catalog = app.get(MailService).templates;
    const [a, b] = await Promise.all([seedMailTemplates(catalog), seedMailTemplates(catalog)]);
    const keys = BACK_OFFICE_MAIL_TEMPLATES.map(item => item.key).sort();
    expect([...a.created, ...b.created].sort()).toEqual(keys);
    expect([...a.created, ...a.existing].sort()).toEqual(keys);
    expect([...b.created, ...b.existing].sort()).toEqual(keys);
    expect(await database.model('emailTemplates').count({})).toBe(keys.length);
  });
  it('a loser of an insert race (unique violation) is reported as existing; any other failure propagates', async () => {
    const rows = new Map<string, unknown>();
    const model = { findUnique: async ({ where }: { where: { key: string } }) => rows.get(where.key) ?? null };
    const catalog = (seed: (key: string) => Promise<unknown>) => ({
      options: { database: { model: () => model }, model: 'emailTemplates' },
      hasBuiltIn: () => true, listBuiltIns: () => [{ key: 'k1' }, { key: 'k2' }], seed,
    }) as never;
    const raced = await seedMailTemplates(catalog(async key => { rows.set(key, {}); throw new Error('unique violation'); }));
    expect(raced).toEqual({ created: [], existing: ['k1', 'k2'] });
    rows.clear();
    await expect(seedMailTemplates(catalog(async () => { throw new Error('connection lost'); }))).rejects.toThrow('connection lost');
  });
  it('the seeding feature stores selected built-ins at bootstrap and never blocks startup on failure', async () => {
    const some = await boot({ features: { admin: false, seedTemplates: [MAIL_TEMPLATE_KEYS.verify, MAIL_TEMPLATE_KEYS.reset] } });
    await some.app.init();
    expect(((await some.database.model('emailTemplates').findMany({})) as Array<{ key: string }>).map(row => row.key).sort()).toEqual([MAIL_TEMPLATE_KEYS.reset, MAIL_TEMPLATE_KEYS.verify]);
    const all = await boot({ features: { admin: false, seedTemplates: true }, templates: { builtIns: BACK_OFFICE_MAIL_TEMPLATES } });
    await all.app.init();
    expect(await all.database.model('emailTemplates').count({})).toBe(BACK_OFFICE_MAIL_TEMPLATES.length);
    // Broken storage: startup still succeeds.
    const database = new InMemoryAdapter();
    vi.spyOn(database, 'model').mockImplementation(() => { throw new Error('storage down'); });
    @Module({ imports: [
      { module: class BrokenDb {}, global: true, providers: [{ provide: DATABASE_ADAPTER, useValue: database }], exports: [DATABASE_ADAPTER] },
      BackOfficeMailModule.forRoot({ settings: Settings, features: { admin: false, seedTemplates: true } })] })
    class Broken {}
    const app = await NestFactory.createApplicationContext(Broken, { logger: false });
    apps.push(app);
    await expect(app.init()).resolves.toBeDefined();
  });
});

describe('mail options validation', () => {
  it.each([
    [{ settings: 'x' }, /settings must be an injectable class/],
    [{ site: null }, /site must be/],
    [{ templates: { builtIns: [{ key: '' }] } }, /needs a key/],
    [{ templates: { builtIns: [ACCOUNT_MAIL_TEMPLATES[0], ACCOUNT_MAIL_TEMPLATES[0]] } }, /duplicate built-in/],
    [{ templates: { contentFields: { EN: 'a' } } }, /lowercase language/],
    [{ templates: { defaultLocale: 'fr' } }, /defaultLocale needs a content field/],
    [{ links: { nope: '/x' } }, /unknown link/],
    [{ links: { verifyEmail: 'https://evil.invalid' } }, /site-relative/],
    [{ links: { verifyEmail: '//evil.invalid' } }, /site-relative/],
    [{ features: { bogus: true } }, /unknown feature/],
    [{ features: { seedTemplates: ['nope'] } }, /unknown built-in/],
    [{ features: { seedTemplates: 'yes' } }, /boolean or a list/],
    [{ admin: { templatesPath: '../x' } }, /invalid admin path/],
    [{ templates: { subjects: { k: 'text' } } }, /must map locales/],
  ] as const)('refuses invalid options %#', (input, message) => {
    expect(() => resolveMailOptions(input as never)).toThrow(message);
  });
  it('defaults and freezes', () => {
    const options = resolveMailOptions();
    expect(options).toMatchObject({ localePrefix: true, defaultLocale: 'en', locales: ['en', 'zh'],
      features: { admin: true, accountMailer: true, receipts: false, seedTemplates: false },
      admin: { templatesPath: 'management/email-templates', logsPath: 'management/email-logs', read: 'mail:query', write: 'mail:update' } });
    expect(Object.isFrozen(options)).toBe(true);
    expect(options.subjects[VERIFICATION_CODE_MAIL_KEY]).toEqual(VERIFICATION_CODE_MAIL_TEMPLATE.defaultSubject ? { en: 'Your verification code', zh: '你的验证码' } : {});
  });
});
