import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { DATABASE_ADAPTER, type DatabaseAdapter } from '@zucker-framework/core';
import { MailService, type MailSendResult } from '@zucker-framework/notification';
import { RUNTIME_ENVIRONMENT } from '../runtime-settings/runtime-settings.tokens';
import { defaultMailSubject, mailLocale, type MailLocale, type MailTemplateKey } from './mail-templates';

export interface TransactionalMailMessage {
  to: string;
  locale: string | null | undefined;
  userId?: string;
  /** Template variables (raw values; the catalog escapes them). `siteName` is added automatically. */
  data: Record<string, string | number>;
  /** Stored in `email_logs.metadata`; ids only, never tickets, links or secrets. */
  logMetadata?: Record<string, string | number>;
}

/** Site name shown in mail: `SITE_NAME`, else the host of `WEB_URL`. Control characters are removed. */
function siteName(environment: Readonly<NodeJS.ProcessEnv>, base: URL | null): string {
  const configured = environment.SITE_NAME?.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 100);
  return configured || base?.host || 'Zucker';
}
function webBase(raw: string | undefined): URL | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url : null;
  } catch { return null; }
}

/**
 * Template-owned transactional mail on the shared MailService: picks the stored or built-in template,
 * localises the subject, records every attempt in `email_logs` and builds links on the configured
 * `WEB_URL` origin only (never a request Host).
 */
@Injectable()
export class TransactionalMail {
  private readonly logger = new Logger(TransactionalMail.name);
  private readonly base: URL | null;
  private readonly site: string;
  constructor(private readonly mail: MailService, @Inject(DATABASE_ADAPTER) private readonly database: DatabaseAdapter,
    @Optional() @Inject(RUNTIME_ENVIRONMENT) environment?: Readonly<NodeJS.ProcessEnv>) {
    const env = environment ?? process.env;
    this.base = webBase(env.WEB_URL);
    this.site = siteName(env, this.base);
  }

  /** A transport is configured and links can be built. */
  isEnabled(): boolean { return !!this.base && this.mail.isMailEnabled(); }

  /** `<WEB_URL>/<locale><path>`, optionally with a fragment (bearer tickets stay out of logs and referrers). */
  link(locale: string | null | undefined, path: string, fragment?: Record<string, string>): string {
    if (!this.base) throw new Error('WEB_URL is not configured');
    if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Mail link path must be site-relative');
    const url = new URL(`/${mailLocale(locale)}${path}`, this.base);
    if (fragment) url.hash = new URLSearchParams(fragment).toString();
    return url.href;
  }

  private async subject(key: MailTemplateKey, locale: MailLocale): Promise<string> {
    try {
      const row = await this.database.model('emailTemplates').findUnique({ where: { key }, select: { subject: true, isActive: true } }) as
        { subject: string | null; isActive: boolean } | null;
      const stored = row?.isActive ? row.subject?.replace(/[\r\n\0]/g, ' ').trim() : '';
      if (stored) return stored;
    } catch { this.logger.warn('Stored mail subject lookup failed; using the built-in subject'); }
    return defaultMailSubject(key, locale);
  }

  async send(key: MailTemplateKey, message: TransactionalMailMessage): Promise<MailSendResult> {
    const locale = mailLocale(message.locale);
    return this.mail.sendTemplateMailWithResult(message.to, key, { siteName: this.site, ...message.data }, await this.subject(key, locale),
      message.userId, message.logMetadata, locale);
  }
}
