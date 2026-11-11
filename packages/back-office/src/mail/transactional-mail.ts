import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { DATABASE_ADAPTER, type DatabaseAdapter } from '@zucker-framework/core';
import { MailService, type MailSendResult } from '@zucker-framework/notification';
import type { MailSitePort, ResolvedMailOptions } from './mail.options';
import { MAIL_OPTIONS, MAIL_SITE } from './mail.tokens';

export interface TransactionalMailMessage {
  to: string;
  locale: string | null | undefined;
  userId?: string;
  /** Template variables (raw values; the catalog escapes them). `siteName` is added automatically. */
  data: Record<string, string | number>;
  /** Stored in the mail log `metadata`; ids only, never tickets, links or secrets. */
  logMetadata?: Record<string, string | number>;
}

/** Site name shown in mail: configured name, else the host of the web URL. Control characters are removed. */
function siteName(configured: string | null | undefined, base: URL | null): string {
  const name = configured?.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 100);
  return name || base?.host || 'Zucker';
}
function webBase(raw: string | null | undefined): URL | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url : null;
  } catch { return null; }
}

/**
 * Transactional mail on the shared MailService: picks the stored or built-in template, localises the
 * subject, records every attempt in the mail log and builds links on the configured public origin
 * only (never a request Host).
 */
@Injectable()
export class TransactionalMail {
  private readonly logger = new Logger(TransactionalMail.name);
  private readonly base: URL | null;
  private readonly site: string;
  constructor(@Inject(MailService) private readonly mail: MailService, @Inject(DATABASE_ADAPTER) private readonly database: DatabaseAdapter,
    @Inject(MAIL_OPTIONS) readonly options: ResolvedMailOptions, @Optional() @Inject(MAIL_SITE) site?: MailSitePort) {
    this.base = webBase(site?.webUrl);
    this.site = siteName(site?.siteName, this.base);
  }

  /** A transport is configured and links can be built. */
  isEnabled(): boolean { return !!this.base && this.mail.isMailEnabled(); }
  /** A transport is configured (mail without links, e.g. codes, needs no web URL). */
  canSend(): boolean { return this.mail.isMailEnabled(); }

  /**
   * Deletes the delivery-log rows of one recipient and template (MailService history fields
   * `recipient`, `template`), e.g. so the address of an erased account is not retained.
   */
  async forgetRecipient(recipient: string, template: string): Promise<number> {
    const result = await this.database.model(this.options.models.emailLogs).deleteMany({ where: { recipient, template } }) as { count?: number } | undefined;
    return result?.count ?? 0;
  }

  /** The supported locale for a recipient preference (`zh-CN` → `zh`), else the default locale. */
  locale(locale: string | null | undefined): string {
    const language = locale?.split(/[-_]/)[0]?.toLowerCase();
    return language && this.options.locales.includes(language) ? language : this.options.defaultLocale;
  }

  /** `<webUrl>[/<locale>]<path>`, optionally with a fragment (bearer tickets stay out of logs and referrers). */
  link(locale: string | null | undefined, path: string, fragment?: Record<string, string>): string {
    if (!this.base) throw new Error('Mail web URL is not configured');
    if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Mail link path must be site-relative');
    const url = new URL(this.options.localePrefix ? `/${this.locale(locale)}${path}` : path, this.base);
    if (fragment) url.hash = new URLSearchParams(fragment).toString();
    return url.href;
  }

  /** Stored active subject, else the configured localised subject, else the built-in default subject, else the key. */
  async subject(key: string, locale: string): Promise<string> {
    try {
      const row = await this.database.model(this.options.models.emailTemplates).findUnique({ where: { key }, select: { subject: true, isActive: true } }) as
        { subject: string | null; isActive: boolean } | null;
      const stored = row?.isActive ? row.subject?.replace(/[\r\n\0]/g, ' ').trim() : '';
      if (stored) return stored;
    } catch { this.logger.warn('Stored mail subject lookup failed; using the built-in subject'); }
    const localised = this.options.subjects[key];
    return localised?.[locale] ?? localised?.[this.options.defaultLocale]
      ?? this.options.builtIns.find((template) => template.key === key)?.defaultSubject ?? key;
  }

  async send(key: string, message: TransactionalMailMessage): Promise<MailSendResult> {
    const locale = this.locale(message.locale);
    return this.mail.sendTemplateMailWithResult(message.to, key, { siteName: this.site, ...message.data }, await this.subject(key, locale),
      message.userId, message.logMetadata, locale);
  }
}
