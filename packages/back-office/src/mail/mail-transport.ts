import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import {
  EmailProvider,
  ResendEmailProvider,
  type MailDeliveryContext,
  type MailProvider,
  type SendMailOptions,
  type SendMailResult,
} from '@zucker-framework/notification';

export type MailTransportKind = 'smtp' | 'resend';
export const MAIL_TRANSPORT_KINDS: readonly MailTransportKind[] = ['smtp', 'resend'];
export interface MailTransportSettings { kind: MailTransportKind; from: string; resendApiKey: string }
export interface SmtpSettings { host: string; port: number; secure: boolean; from: string; user: string; password: string }
/** Parsed transport configuration (plain data, no clients). `transport: null` = unconfigured. */
export interface MailSettings { readonly transport: MailTransportSettings | null; readonly smtp: SmtpSettings }

/**
 * Where the transport reads its settings. `now()` is called on every use (it must be cheap and
 * synchronous); `refresh()` (optional) runs before each send so a background sender picks up a newer
 * saved revision (hot-applied connection profiles). Consumers implement it over their own source:
 * the template over its hot `account-email` profile, a product over its configuration service.
 */
export interface MailSettingsSource {
  now(): MailSettings;
  refresh?(): Promise<unknown>;
}

/** Host defaults of well-known SMTP relays; the password (and usually the sender) comes from configuration. */
export interface SmtpPreset { readonly host: string; readonly port: number; readonly secure: boolean; readonly user?: string }
export const SMTP_PRESETS: Readonly<Record<string, SmtpPreset>> = Object.freeze({
  /** Cloudflare Email Service: implicit TLS, the API token is the password. */
  cloudflare: Object.freeze({ host: 'smtp.mx.cloudflare.net', port: 465, secure: true, user: 'api_token' }),
  /** Resend over SMTP (the API transport is `kind: 'resend'`). */
  'resend-smtp': Object.freeze({ host: 'smtp.resend.com', port: 465, secure: true, user: 'resend' }),
  sendgrid: Object.freeze({ host: 'smtp.sendgrid.net', port: 587, secure: false, user: 'apikey' }),
  mailgun: Object.freeze({ host: 'smtp.mailgun.org', port: 587, secure: false }),
  postmark: Object.freeze({ host: 'smtp.postmarkapp.com', port: 587, secure: false }),
  gmail: Object.freeze({ host: 'smtp.gmail.com', port: 465, secure: true }),
  office365: Object.freeze({ host: 'smtp.office365.com', port: 587, secure: false }),
});

/**
 * SMTP settings from a preset plus the consumer's values (explicit values win over the preset).
 * Throws on an unknown preset, a header-injection sender or an invalid port.
 */
export function smtpSettingsFromPreset(preset: string, values: { from: string; password: string; user?: string; host?: string; port?: number; secure?: boolean },
  presets: Readonly<Record<string, SmtpPreset>> = SMTP_PRESETS): SmtpSettings {
  const base = Object.prototype.hasOwnProperty.call(presets, preset) ? presets[preset] : undefined;
  if (!base) throw new TypeError(`[back-office/mail] unknown SMTP preset "${preset}"`);
  const settings = { host: values.host ?? base.host, port: values.port ?? base.port, secure: values.secure ?? base.secure,
    from: values.from.trim(), user: values.user ?? base.user ?? '', password: values.password };
  if (/[\r\n]/.test(settings.from)) throw new TypeError('[back-office/mail] sender must be a single line');
  if (!Number.isSafeInteger(settings.port) || settings.port < 1 || settings.port > 65535) throw new TypeError('[back-office/mail] invalid SMTP port');
  return settings;
}

/**
 * Reads the SMTP fields of the `account-email` descriptor from a resolved environment object
 * (`SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_FROM`, `SMTP_USER`, `SMTP_PASSWORD`). With a preset,
 * the preset fills host/port/TLS/user that the environment leaves empty.
 */
export function smtpSettingsFromConnection(environment: Readonly<Record<string, string | undefined>>, preset?: SmtpPreset): SmtpSettings {
  const from = environment.SMTP_FROM?.trim() ?? '', password = environment.SMTP_PASSWORD ?? '';
  if (!preset) return { host: environment.SMTP_HOST?.trim() ?? '', port: Number(environment.SMTP_PORT ?? 587),
    secure: environment.SMTP_SECURE === 'true', from, user: environment.SMTP_USER ?? '', password };
  const blank = (value: string | undefined) => value === undefined || value.trim() === '';
  return { host: blank(environment.SMTP_HOST) ? preset.host : environment.SMTP_HOST!.trim(),
    port: blank(environment.SMTP_PORT) ? preset.port : Number(environment.SMTP_PORT),
    secure: blank(environment.SMTP_SECURE) ? preset.secure : environment.SMTP_SECURE === 'true',
    from, user: blank(environment.SMTP_USER) ? preset.user ?? '' : environment.SMTP_USER!, password };
}

/**
 * Reads the transport choice: `MAIL_PROVIDER` = `smtp` (default) | `resend` (`MAIL_RESEND_API_KEY`) |
 * a preset name when `presets` is given (an SMTP transport). The sender is `SMTP_FROM` for every kind.
 * An unknown value is unconfigured (`null`) rather than a silent SMTP fallback.
 */
export function mailTransportSettingsFromConnection(environment: Readonly<Record<string, string | undefined>>,
  presets?: Readonly<Record<string, SmtpPreset>>): MailTransportSettings | null {
  const raw = environment.MAIL_PROVIDER?.trim() || 'smtp';
  const kind: MailTransportKind | null = MAIL_TRANSPORT_KINDS.includes(raw as MailTransportKind) ? raw as MailTransportKind
    : presets && Object.prototype.hasOwnProperty.call(presets, raw) ? 'smtp' : null;
  if (!kind) return null;
  return { kind, from: environment.SMTP_FROM?.trim() ?? '', resendApiKey: environment.MAIL_RESEND_API_KEY ?? '' };
}

/** Both parsers together: `{ transport, smtp }` from one environment object (presets optional). */
export function mailSettingsFromConnection(environment: Readonly<Record<string, string | undefined>>,
  presets?: Readonly<Record<string, SmtpPreset>>): MailSettings {
  const provider = environment.MAIL_PROVIDER?.trim() ?? '';
  const preset = presets && Object.prototype.hasOwnProperty.call(presets, provider) ? presets[provider] : undefined;
  return Object.freeze({ transport: mailTransportSettingsFromConnection(environment, presets), smtp: smtpSettingsFromConnection(environment, preset) });
}

/**
 * One provider client per settings key. When the key changes a new client is built; the previous one
 * is closed once no `lease` holds it any more (a send that started on it finishes on it).
 */
export class LeasedProvider<T> {
  private entry: { key: string; provider: T; leases: number; retired: boolean } | null = null;
  private readonly retiring = new Set<{ provider: T; leases: number; retired: boolean }>();
  constructor(private readonly dispose: (provider: T) => Promise<void> | void) {}
  /** The client for `key`, building it with `build` (and retiring the previous one) when the key changed. */
  current(key: string, build: () => T): T {
    if (this.entry?.key !== key) {
      const previous = this.entry;
      this.entry = { key, provider: build(), leases: 0, retired: false };
      if (previous) void this.retire(previous);
    }
    return this.entry.provider;
  }
  /** Runs `work` with `provider` held open. */
  async lease<R>(provider: T, work: (provider: T) => Promise<R>): Promise<R> {
    const entry = this.entry?.provider === provider ? this.entry : [...this.retiring].find(row => row.provider === provider);
    if (!entry) return work(provider);
    entry.leases += 1;
    try { return await work(provider); }
    finally { entry.leases -= 1; if (entry.retired) await this.closeIfIdle(entry); }
  }
  /** Retires the current client; it closes when its last lease ends. */
  async close(): Promise<void> {
    const entry = this.entry; this.entry = null;
    if (entry) await this.retire(entry);
  }
  private retire(entry: { provider: T; leases: number; retired: boolean }): Promise<void> {
    entry.retired = true; this.retiring.add(entry);
    return this.closeIfIdle(entry);
  }
  private async closeIfIdle(entry: { provider: T; leases: number; retired: boolean }): Promise<void> {
    if (entry.leases > 0 || !this.retiring.delete(entry)) return;
    try { await this.dispose(entry.provider); } catch { /* closing a replaced client must not fail a send */ }
  }
}

/**
 * The one SMTP transport. It resolves its settings through `resolve` on every use and builds a new
 * underlying provider when they change. A send keeps the provider it started with; a replaced provider
 * is closed only after its last in-flight send settles.
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

/**
 * The outbound transport of account and transactional mail (MailService). It delegates to the shared
 * `SmtpTransport` or to Resend, chosen from the resolved settings on each use; the Resend client is
 * rebuilt only when its settings change, and a replaced client is closed after its in-flight sends
 * settle. `prepare` (optional) refreshes the settings source before a send.
 */
@Injectable()
export class BackOfficeMailTransport implements MailProvider, OnModuleDestroy {
  readonly supportsIdempotency = false;
  private readonly resend = new LeasedProvider<ResendEmailProvider>(provider => provider.close());
  private closed = false;
  constructor(private readonly smtp: SmtpTransport, private readonly resolve: () => MailTransportSettings | null,
    private readonly prepare?: () => Promise<unknown>) {}

  get name(): string { return this.resolve()?.kind === 'resend' ? 'Resend' : this.smtp.name; }
  private current(): MailProvider | null {
    if (this.closed) return null;
    const settings = this.resolve();
    if (!settings) return null;
    if (settings.kind === 'smtp') return this.smtp;
    const provider = this.resend.current(JSON.stringify([settings.from, settings.resendApiKey]),
      () => new ResendEmailProvider({ apiKey: settings.resendApiKey || undefined, from: settings.from }));
    return settings.from ? provider : null;
  }
  /** Sender address of the current settings. */
  get from(): string { return this.resolve()?.from ?? ''; }
  isConfigured(): boolean { return this.current()?.isConfigured() ?? false; }
  async deliver(options: SendMailOptions, context?: MailDeliveryContext): Promise<SendMailResult> {
    if (!this.closed) await this.prepare?.();
    const provider = this.current();
    if (!provider) return { success: false, error: 'Mail transport is not configured' };
    if (provider === this.smtp) return this.smtp.deliver(options, context);
    return this.resend.lease(provider as ResendEmailProvider, resend => resend.deliver(options, context));
  }
  async close(): Promise<void> {
    this.closed = true;
    await this.resend.close();
    // The SMTP transport is a separate provider with its own lifecycle.
  }
  async onModuleDestroy(): Promise<void> { await this.close(); }
}
