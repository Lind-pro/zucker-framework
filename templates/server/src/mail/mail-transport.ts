import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import {
  ResendEmailProvider, type MailDeliveryContext, type MailProvider, type SendMailOptions, type SendMailResult,
} from '@zucker-framework/notification';
import type { SmtpTransport } from './smtp-transport';

export type MailTransportKind = 'smtp' | 'resend';
export const MAIL_TRANSPORT_KINDS: readonly MailTransportKind[] = ['smtp', 'resend'];
export interface MailTransportSettings { kind: MailTransportKind; from: string; resendApiKey: string }
export interface SmtpSettings { host: string; port: number; secure: boolean; from: string; user: string; password: string }

/** Reads the `account-email` SMTP fields from a resolved runtime environment. */
export function smtpSettingsFromConnection(environment: Readonly<NodeJS.ProcessEnv>): SmtpSettings {
  return { host: environment.SMTP_HOST?.trim() ?? '', port: Number(environment.SMTP_PORT ?? 587),
    secure: environment.SMTP_SECURE === 'true', from: environment.SMTP_FROM?.trim() ?? '',
    user: environment.SMTP_USER ?? '', password: environment.SMTP_PASSWORD ?? '' };
}

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
 * The application's one outbound mail transport for account and transactional mail (MailService).
 * It delegates to the shared `SmtpTransport` or to Resend, chosen from the resolved connection
 * settings on each use; the Resend client is rebuilt only when its settings change, and a replaced
 * client is closed after its in-flight sends settle. `prepare` (optional) refreshes the resolver's
 * source before a send, so a background sender (job worker) uses the newest saved settings.
 */
@Injectable()
export class ApplicationMailTransport implements MailProvider, OnModuleDestroy {
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
    // The SMTP transport is a separate provider with its own lifecycle (SmtpTransportModule).
  }
  async onModuleDestroy(): Promise<void> { await this.close(); }
}
