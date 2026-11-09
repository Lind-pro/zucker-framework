import type { ComponentType, ReactNode } from 'react';
import type { RequestConfig } from '@zucker-framework/fe-http-client';
import type { AdminMessageKey, AdminMessages } from '../i18n/zh-CN';

/**
 * Permission codes used to filter routes, menus and actions. They mirror the server's
 * `<resource>:<action>` codes (RFC §8 and the server template); they never grant access —
 * the API remains authoritative.
 */
export interface AdminPermissionCodes {
  dashboard: { query: string };
  users: { query: string; add: string; update: string; delete: string; authorize: string };
  roles: { query: string; add: string; update: string; delete: string; authorize: string };
  permissions: { query: string; add: string; update: string; delete: string };
  menu: { query: string; add: string; update: string; delete: string };
  dictionary: { query: string; add: string; update: string; delete: string };
  plans: { query: string; add: string; update: string; delete: string };
  subscriptions: { query: string; update: string };
  quota: { query: string; update: string };
  billing: { query: string; refund: string };
  credit: { query: string; grant: string };
  mail: { query: string; update: string };
  logging: { query: string };
  aiModels: { query: string; readSecret: string; add: string; update: string; delete: string };
  config: { query: string; update: string };
  apiKeys: { query: string };
  jobs: { query: string };
  notification: { query: string };
  files: { query: string };
}

const crud = (resource: string) => ({
  query: `${resource}:query`,
  add: `${resource}:add`,
  update: `${resource}:update`,
  delete: `${resource}:delete`,
});

export const defaultAdminPermissions: AdminPermissionCodes = {
  dashboard: { query: 'dashboard:query' },
  users: { ...crud('users'), authorize: 'users:authorize' },
  roles: { ...crud('roles'), authorize: 'roles:authorize' },
  permissions: crud('permissions'),
  menu: crud('menu'),
  dictionary: crud('dictionary'),
  plans: crud('plans'),
  subscriptions: { query: 'subscriptions:query', update: 'subscriptions:update' },
  quota: { query: 'quota:query', update: 'quota:update' },
  billing: { query: 'billing:query', refund: 'billing:refund' },
  credit: { query: 'credit:query', grant: 'credit:grant' },
  mail: { query: 'mail:query', update: 'mail:update' },
  logging: { query: 'logging:query' },
  aiModels: {
    query: 'ai-models:query',
    readSecret: 'ai-models:read-secret',
    add: 'ai-models:add',
    update: 'ai-models:update',
    delete: 'ai-models:delete',
  },
  config: { query: 'config:query', update: 'config:update' },
  apiKeys: { query: 'api-keys:query' },
  jobs: { query: 'jobs:query' },
  notification: { query: 'notification:query' },
  files: { query: 'files:query' },
};

export type AdminPermissionOverrides = { [K in keyof AdminPermissionCodes]?: Partial<AdminPermissionCodes[K]> };

/** Server paths (relative to `apiBase`). Defaults follow the server template and RFC §8. */
export interface AdminEndpoints {
  login: string;
  refresh: string;
  logout: string;
  me: string;
  profile: string;
  password: string;
  sessions: string;
  menuTree: string;
  menuAll: string;
  menu: string;
  users: string;
  roles: string;
  permissions: string;
  permissionTree: string;
  dictionary: string;
  dictionaryItems: string;
  entitlementCatalog: string;
  plans: string;
  userSubscriptions: string;
  quotaUsage: string;
  quotaReservations: string;
  orders: string;
  billingSubscriptions: string;
  refunds: string;
  credits: string;
  emailTemplates: string;
  emailLogs: string;
  accessLogs: string;
  operationLogs: string;
  aiModels: string;
  connections: string;
  connectionSettings: string;
  health: string;
  apiKeys: string;
  jobs: string;
  deliveries: string;
  files: string;
}

export const defaultAdminEndpoints: AdminEndpoints = {
  login: '/authorize/login',
  refresh: '/authorize/refresh',
  logout: '/authorize/logout',
  me: '/authorize/me',
  profile: '/authorize/profile',
  password: '/authorize/password',
  sessions: '/authorize/sessions',
  menuTree: '/menu/tree',
  menuAll: '/menu/all',
  menu: '/menu',
  users: '/users',
  roles: '/roles',
  permissions: '/permissions',
  permissionTree: '/permissions/tree',
  dictionary: '/dictionary',
  dictionaryItems: '/dictionary-item',
  entitlementCatalog: '/billing/entitlements/catalog',
  plans: '/management/plans',
  userSubscriptions: '/management/subscriptions',
  quotaUsage: '/management/quota-usage',
  quotaReservations: '/management/quota-reservations',
  orders: '/management/orders',
  billingSubscriptions: '/management/billing-subscriptions',
  refunds: '/billing/refunds',
  credits: '/management/credits',
  emailTemplates: '/management/email-templates',
  emailLogs: '/management/email-logs',
  accessLogs: '/management/access-logs',
  operationLogs: '/management/operation-logs',
  aiModels: '/management/ai-models',
  connections: '/management/connections',
  connectionSettings: '/management/connection-settings',
  health: '/health',
  apiKeys: '/management/api-keys',
  jobs: '/management/jobs',
  deliveries: '/management/deliveries',
  files: '/management/files',
};

/** Built-in page identifiers; each can be disabled or overridden by key. */
export type AdminPageKey =
  | 'dashboard'
  | 'users'
  | 'roles'
  | 'permissions'
  | 'menu'
  | 'dictionary'
  | 'plans'
  | 'userSubscriptions'
  | 'quotaUsage'
  | 'quotaReservations'
  | 'orders'
  | 'billingSubscriptions'
  | 'refunds'
  | 'credits'
  | 'emailTemplates'
  | 'emailLogs'
  | 'accessLogs'
  | 'operationLogs'
  | 'aiModels'
  | 'connections'
  | 'health'
  | 'apiKeys'
  | 'jobs'
  | 'deliveries'
  | 'files'
  | 'profile';

export interface AdminPageDefinition {
  /** Stable identifier; built-in keys can be overridden or disabled. */
  key: string;
  /** Absolute route path, e.g. `/users`. Menu items from `GET /menu/tree` link to these paths. */
  path: string;
  /** Product pages: a plain title or titles by locale tag (`{ 'zh-CN': '…', 'en-US': '…' }`). */
  title?: string | Readonly<Record<string, string>>;
  /** Built-in pages: a message key. */
  titleKey?: AdminMessageKey;
  /** Required permission; an array means any one of them. Omit for any signed-in user. */
  permission?: string | readonly string[];
  component: ComponentType;
  icon?: ComponentType<{ className?: string }>;
  /** Exclude from dashboard quick links. */
  hideInQuickLinks?: boolean;
}

/** See `AdminAppConfig.serverLabels`. */
export type ServerLabels =
  | Readonly<Record<string, Readonly<Record<string, string>>>>
  | ((text: string, locale: string) => string | undefined);

export interface AdminLocaleOption {
  label: string;
  messages: Partial<AdminMessages>;
}

export interface AdminAppConfig {
  brand?: { name?: string; logo?: ReactNode };
  /** Prefix for API requests (default `/api`). */
  apiBase?: string;
  /** Router basename when the admin is mounted below the site root. */
  basename?: string;
  /** Landing route after login (default `/dashboard`). */
  homePath?: string;
  /** Active locale (default `zh-CN`). */
  locale?: string;
  /**
   * Locales offered by the language switcher. Built-in `zh-CN` and `en-US` copy is used as the
   * base for those tags; other tags start from zh-CN and should provide complete messages.
   * Omit to show no switcher.
   */
  locales?: Record<string, AdminLocaleOption>;
  /** Copy overrides applied to every locale (e.g. product wording). */
  messages?: Partial<AdminMessages>;
  /**
   * Translations for display text the server provides (connection names, categories, field labels
   * and notes, entitlement catalog labels). Either a map per locale tag, or a function returning the
   * translation (or `undefined` to keep the text). Lookups use the stable `labelKey` the server sends
   * next to the text first (for example `connections.payment-stripe`, `connections.field.SMTP_HOST`,
   * `entitlements.feature.projects`), then the exact text, so a wording change on the server does not
   * lose the translation. Text without a translation is shown as received; stored business data is
   * never passed through.
   */
  serverLabels?: ServerLabels;
  permissions?: AdminPermissionOverrides;
  endpoints?: Partial<AdminEndpoints>;
  /** Disable (`false`) or override built-in pages by key. */
  pages?: Partial<Record<AdminPageKey, false | Partial<Omit<AdminPageDefinition, 'key'>>>>;
  /** Product-specific routes, rendered inside the shell and gated like built-in pages. */
  extraPages?: readonly AdminPageDefinition[];
  session?: {
    /** JWT claims that identify one session (default `['sub', 'sid']`). */
    claims?: readonly string[];
    /** localStorage key for the persisted (token-free) session summary. */
    storageKey?: string;
    /** Cross-tab lock shared with other apps using the same refresh cookie. */
    refreshLockName?: string;
    /** Per-attempt cookie refresh timeout in ms (default 15000); a timeout fails the restore. */
    refreshTimeoutMs?: number;
  };
  /**
   * Override the cookie refresh transport (default `createKeepaliveCookieRefresh(apiBase + endpoints.refresh)`
   * from fe-http-client). It receives an AbortSignal that fires on timeout.
   */
  refresh?: (signal?: AbortSignal) => Promise<{ access_token: string }>;
  users?: {
    /** Extra fields sent when creating a user (consumer registration policy, e.g. a type id). */
    createDefaults?: Record<string, unknown>;
  };
  mail?: {
    /** Locale → template content column, matching the server's MailTemplateCatalog contentFields. */
    contentFields?: Record<string, string>;
    /** Locales offered for preview (default: keys of contentFields). */
    previewLocales?: readonly string[];
  };
  ai?: {
    /**
     * Provider identifiers accepted by the server's AIModelCatalogService. Required when the
     * `aiModels` page is enabled: without it the page explains the missing setting and offers no
     * create/edit (the list of providers is product vocabulary, not a library default).
     */
    providers?: readonly string[];
  };
  /**
   * Payment provider ids whose price references the plan editor shows (default
   * `['stripe', 'paypal', 'creem']`). Each becomes a `providerRefs` key of a plan price.
   */
  paymentProviders?: readonly string[];
  /** HTTP adapter for both clients (tests, custom transports). */
  httpAdapter?: RequestConfig['adapter'];
  /** Request timeout in ms (default 60000). */
  timeout?: number;
}

export interface ResolvedAdminConfig {
  brandName?: string;
  logo?: ReactNode;
  apiBase: string;
  basename?: string;
  homePath: string;
  endpoints: AdminEndpoints;
  permissions: AdminPermissionCodes;
  usersCreateDefaults: Record<string, unknown>;
  mailContentFields: Record<string, string>;
  mailPreviewLocales: readonly string[];
  aiProviders: readonly string[];
  paymentProviders: readonly string[];
}

export function resolvePermissions(overrides: AdminPermissionOverrides = {}): AdminPermissionCodes {
  const result = { ...defaultAdminPermissions } as Record<string, Record<string, string>>;
  for (const [key, value] of Object.entries(overrides)) {
    if (value) result[key] = { ...result[key], ...(value as Record<string, string>) };
  }
  return result as unknown as AdminPermissionCodes;
}

export function resolveConfig(config: AdminAppConfig): ResolvedAdminConfig {
  const contentFields = config.mail?.contentFields ?? { zh: 'htmlContentZh', en: 'htmlContentEn' };
  return {
    brandName: config.brand?.name,
    logo: config.brand?.logo,
    apiBase: (config.apiBase ?? '/api').replace(/\/$/, ''),
    basename: config.basename,
    homePath: config.homePath ?? '/dashboard',
    endpoints: { ...defaultAdminEndpoints, ...config.endpoints },
    permissions: resolvePermissions(config.permissions),
    usersCreateDefaults: { ...config.users?.createDefaults },
    mailContentFields: contentFields,
    mailPreviewLocales: config.mail?.previewLocales ?? Object.keys(contentFields),
    aiProviders: config.ai?.providers ?? [],
    paymentProviders: config.paymentProviders ?? ['stripe', 'paypal', 'creem'],
  };
}
