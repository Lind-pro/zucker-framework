import type { CanActivate, Type } from '@nestjs/common';
import type { BuiltInMailTemplate } from '@zucker-framework/notification';
import { resolveModelNames, type ModelNames } from '../shared/models';
import { ACCOUNT_MAIL_TEMPLATES, DEFAULT_MAIL_SUBJECTS, VERIFICATION_CODE_MAIL_TEMPLATE } from './mail-templates';
import type { MailSettingsSource } from './mail-transport';

export const DEFAULT_MAIL_MODELS = {
  emailTemplates: 'emailTemplates',
  emailLogs: 'emailLogs',
  users: 'users',
  billingOrders: 'billingOrders',
  billingFulfillments: 'billingFulfillments',
} as const;
export type MailModelKey = keyof typeof DEFAULT_MAIL_MODELS;
/** Raw SQL (receipt "already sent" lookup); always double-quoted. */
export const DEFAULT_MAIL_TABLES = { emailLogs: 'email_logs' } as const;
export type MailTableKey = keyof typeof DEFAULT_MAIL_TABLES;

/** Site-relative paths of the links the built-in mails carry. */
export const DEFAULT_MAIL_LINKS = Object.freeze({
  verifyEmail: '/verify-email',
  resetPassword: '/reset-password',
  magicLink: '/magic-link',
  welcome: '/account',
  deletionCancel: '/login',
  twoFactorReset: '/account/security',
  receipt: '/billing/orders',
});
export type MailLinkKey = keyof typeof DEFAULT_MAIL_LINKS;

/** Public origin and display name used in mail; read once when the mail service is built. */
export interface MailSitePort {
  readonly webUrl?: string | null;
  readonly siteName?: string | null;
}

export interface BackOfficeMailOptions {
  /** Transport settings (SMTP / Resend). Omit = no transport: nothing is sent, admin pages still work. */
  settings?: Type<MailSettingsSource>;
  /** `{ webUrl, siteName }` value or an injectable class exposing them. Links need an http(s) `webUrl`. */
  site?: MailSitePort | Type<MailSitePort>;
  templates?: {
    /** Code fallbacks (default `ACCOUNT_MAIL_TEMPLATES`); a stored, active row with the same key wins. */
    builtIns?: readonly BuiltInMailTemplate[];
    /** Localised default subjects per key (merged over the built-in account/billing subjects). */
    subjects?: Readonly<Record<string, Readonly<Record<string, string>>>>;
    /** Template content field per locale (default `{ en: 'htmlContentEn', zh: 'htmlContentZh' }`). */
    contentFields?: Readonly<Record<string, string>>;
    /** Locale used when the recipient's is unknown or unsupported (default `en`). */
    defaultLocale?: string;
  };
  /** Prefix links with `/<locale>` (default true: `<webUrl>/en/verify-email`). */
  localePrefix?: boolean;
  links?: Partial<Record<MailLinkKey, string>>;
  models?: Partial<Record<MailModelKey, string>>;
  tables?: Partial<Record<MailTableKey, string>>;
  features?: {
    /** `management/email-templates` + `management/email-logs` controllers (default true). */
    admin?: boolean;
    /** `BackOfficeAccountMailer` under `MAIL_ACCOUNT_MAILER` (default true). */
    accountMailer?: boolean;
    /** Payment receipt sender `BillingReceiptMailer` (default false: needs the billing models). */
    receipts?: boolean;
    /** Store built-in templates as editable rows at startup (missing keys only); `true` = all built-ins. */
    seedTemplates?: boolean | readonly string[];
  };
  admin?: {
    templatesPath?: string;
    logsPath?: string;
    permissions?: { read?: string; write?: string };
    auditModule?: string;
    /** Omit for Framework guards; `[]` when equivalent guards are global. */
    guards?: Type<CanActivate>[];
  };
  /** Mail queue pacing passed to MailService. */
  delivery?: { minimumIntervalMs?: number; maxRetries?: number; defaultReplyTo?: string };
}

export interface ResolvedMailOptions {
  readonly settings?: Type<MailSettingsSource>;
  readonly site?: MailSitePort | Type<MailSitePort>;
  readonly builtIns: readonly BuiltInMailTemplate[];
  readonly subjects: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly contentFields: Readonly<Record<string, string>>;
  readonly locales: readonly string[];
  readonly defaultLocale: string;
  readonly localePrefix: boolean;
  readonly links: Readonly<Record<MailLinkKey, string>>;
  readonly models: ModelNames<MailModelKey>;
  readonly tables: ModelNames<MailTableKey>;
  readonly features: { readonly admin: boolean; readonly accountMailer: boolean; readonly receipts: boolean; readonly seedTemplates: false | 'all' | readonly string[] };
  readonly admin: { readonly templatesPath: string; readonly logsPath: string; readonly read: string; readonly write: string; readonly auditModule: string;
    readonly guards?: readonly Type<CanActivate>[] };
  readonly delivery: { readonly minimumIntervalMs?: number; readonly maxRetries?: number; readonly defaultReplyTo?: string };
}

const fail = (message: string): never => {
  throw new TypeError(`[back-office/mail] ${message}`);
};
const PATH = /^[A-Za-z0-9][A-Za-z0-9/_-]*$/;
const LOCALE = /^[a-z]{2,3}$/;

export function resolveMailOptions(input: BackOfficeMailOptions = {}): ResolvedMailOptions {
  if (!input || typeof input !== 'object') fail('options must be an object');
  if (input.settings !== undefined && typeof input.settings !== 'function') fail('settings must be an injectable class');
  if (input.site !== undefined && (input.site === null || (typeof input.site !== 'function' && typeof input.site !== 'object'))) fail('site must be a value or an injectable class');
  const builtIns = [...(input.templates?.builtIns ?? ACCOUNT_MAIL_TEMPLATES)];
  const keys = new Set<string>();
  for (const template of builtIns) {
    if (!template || typeof template.key !== 'string' || !template.key) fail('every built-in template needs a key');
    if (keys.has(template.key)) fail(`duplicate built-in template "${template.key}"`);
    keys.add(template.key);
  }
  const contentFields = { ...(input.templates?.contentFields ?? { en: 'htmlContentEn', zh: 'htmlContentZh' }) };
  const locales = Object.keys(contentFields);
  for (const locale of locales) if (!LOCALE.test(locale)) fail(`locale "${locale}" must be a lowercase language code`);
  const defaultLocale = input.templates?.defaultLocale ?? (locales.includes('en') ? 'en' : locales[0]);
  if (!defaultLocale || !locales.includes(defaultLocale)) fail('defaultLocale needs a content field');
  const links: Record<MailLinkKey, string> = { ...DEFAULT_MAIL_LINKS };
  for (const [key, value] of Object.entries(input.links ?? {})) {
    if (!(key in links)) fail(`unknown link "${key}"`);
    if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) fail(`link "${key}" must be site-relative`);
    links[key as MailLinkKey] = value;
  }
  const features = input.features ?? {};
  // The account mailer's code mail needs its template; add the built-in unless one is configured.
  if ((features.accountMailer ?? true) && !keys.has(VERIFICATION_CODE_MAIL_TEMPLATE.key)) {
    builtIns.push(VERIFICATION_CODE_MAIL_TEMPLATE);
    keys.add(VERIFICATION_CODE_MAIL_TEMPLATE.key);
  }
  for (const key of Object.keys(features)) if (!['admin', 'accountMailer', 'receipts', 'seedTemplates'].includes(key)) fail(`unknown feature "${key}"`);
  const seed = features.seedTemplates ?? false;
  if (Array.isArray(seed)) for (const key of seed) if (!keys.has(key)) fail(`seedTemplates names unknown built-in "${String(key)}"`);
  if (!Array.isArray(seed) && typeof seed !== 'boolean') fail('seedTemplates must be a boolean or a list of keys');
  const admin = input.admin ?? {};
  const templatesPath = admin.templatesPath ?? 'management/email-templates', logsPath = admin.logsPath ?? 'management/email-logs';
  for (const path of [templatesPath, logsPath]) if (typeof path !== 'string' || !PATH.test(path)) fail(`invalid admin path "${String(path)}"`);
  const subjects: Record<string, Readonly<Record<string, string>>> = { ...DEFAULT_MAIL_SUBJECTS };
  for (const [key, value] of Object.entries(input.templates?.subjects ?? {})) {
    if (!value || typeof value !== 'object') fail(`subjects.${key} must map locales to text`);
    subjects[key] = Object.freeze({ ...value });
  }
  return Object.freeze({
    ...(input.settings ? { settings: input.settings } : {}),
    ...(input.site ? { site: input.site } : {}),
    builtIns: Object.freeze(builtIns),
    subjects: Object.freeze(subjects),
    contentFields: Object.freeze(contentFields),
    locales: Object.freeze(locales),
    defaultLocale,
    localePrefix: input.localePrefix ?? true,
    links: Object.freeze(links),
    models: resolveModelNames('mail', DEFAULT_MAIL_MODELS, input.models),
    tables: resolveModelNames('mail', DEFAULT_MAIL_TABLES, input.tables),
    features: Object.freeze({
      admin: features.admin ?? true,
      accountMailer: features.accountMailer ?? true,
      receipts: features.receipts ?? false,
      seedTemplates: seed === true ? 'all' as const : seed === false ? false as const : Object.freeze([...seed]),
    }),
    admin: Object.freeze({
      templatesPath, logsPath, read: admin.permissions?.read ?? 'mail:query', write: admin.permissions?.write ?? 'mail:update',
      auditModule: admin.auditModule ?? 'mail', ...(admin.guards ? { guards: Object.freeze([...admin.guards]) } : {}),
    }),
    delivery: Object.freeze({ ...(input.delivery ?? {}) }),
  });
}
