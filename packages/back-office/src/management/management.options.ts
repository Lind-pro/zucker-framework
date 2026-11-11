import type { CanActivate, Type } from '@nestjs/common';
import { resolveModelNames, type ModelNames } from '../shared/models';
import type {
  ManagementConnectionsPort,
  ManagementCreditLedgerPort,
  ManagementCreditsPort,
  ManagementRefundSummaryPort,
} from './management.ports';

/** Logical models read by the record projections and the credit grant. */
export const DEFAULT_MANAGEMENT_MODELS = {
  apiKeys: 'accountApiKeys',
  orders: 'billingOrders',
  billingSubscriptions: 'billingSubscriptions',
  jobs: 'AsyncJob',
  deliveries: 'NotificationDelivery',
  files: 'fileAssets',
  credits: 'creditTransaction',
  creditAccounts: 'creditAccount',
  creditLots: 'creditLots',
  operationLogs: 'operationLogs',
  users: 'users',
} as const;
export type ManagementModelKey = keyof typeof DEFAULT_MANAGEMENT_MODELS;

/** Tables addressed by raw SQL (credit grant row lock only). Always double-quoted. */
export const DEFAULT_MANAGEMENT_TABLES = { users: 'users' } as const;
export type ManagementTableKey = keyof typeof DEFAULT_MANAGEMENT_TABLES;

/** Read-only record lists, each one route `GET <path>/<route>`. */
export const MANAGEMENT_RECORD_FEATURES = [
  'apiKeys', 'orders', 'billingSubscriptions', 'jobs', 'deliveries', 'files', 'accessLogs', 'operationLogs', 'credits',
] as const;
export type ManagementRecordFeature = (typeof MANAGEMENT_RECORD_FEATURES)[number];
export type ManagementFeature = ManagementRecordFeature | 'creditAccounts' | 'connections';

export const DEFAULT_MANAGEMENT_PERMISSIONS: Readonly<Record<ManagementFeature | 'creditGrant', string>> = Object.freeze({
  apiKeys: 'api-keys:query',
  orders: 'billing:query',
  billingSubscriptions: 'billing:query',
  jobs: 'jobs:query',
  deliveries: 'notification:query',
  files: 'files:query',
  accessLogs: 'logging:query',
  operationLogs: 'logging:query',
  credits: 'credit:query',
  creditAccounts: 'credit:query',
  creditGrant: 'credit:grant',
  connections: 'config:query',
});

export interface BackOfficeManagementOptions {
  /** Route prefix (default `management`). */
  path?: string;
  models?: Partial<Record<ManagementModelKey, string>>;
  tables?: Partial<Record<ManagementTableKey, string>>;
  /**
   * Every feature is individually switchable; a disabled feature registers no route and touches no
   * table. Record lists default to on, except `credits`; `creditAccounts` (balance, lots, grant)
   * needs `ports.credits` + `ports.creditLedger`; `connections` needs `ports.connections`.
   */
  features?: Partial<Record<ManagementFeature, boolean>>;
  permissions?: Partial<Record<ManagementFeature | 'creditGrant', string>>;
  /**
   * Browser origins allowed to call the state-changing credit grant (exact `Origin` match; a
   * `Sec-Fetch-Site: cross-site` request is refused). A function is read once per controller instance.
   */
  trustedOrigins?: readonly string[] | (() => readonly string[]);
  /** Rate limiter applied to every management route (`@zucker-framework/rate-limiter`), keyed by user. `false` = none. */
  rateLimit?: { limiter: string } | false;
  /** Omit for `JwtAuthGuard` + `PermissionsGuard`; `[]` when equivalent guards are global. */
  guards?: Type<CanActivate>[];
  ports?: {
    /** Order refund summary column (`orders` rows get `refund`); without it `refund` is `null`. */
    refunds?: Type<ManagementRefundSummaryPort>;
    credits?: Type<ManagementCreditsPort>;
    creditLedger?: Type<ManagementCreditLedgerPort>;
    connections?: Type<ManagementConnectionsPort>;
  };
}

export interface ResolvedManagementOptions {
  readonly path: string;
  readonly models: ModelNames<ManagementModelKey>;
  readonly tables: ModelNames<ManagementTableKey>;
  readonly features: Readonly<Record<ManagementFeature, boolean>>;
  readonly permissions: Readonly<Record<ManagementFeature | 'creditGrant', string>>;
  readonly trustedOrigins: () => readonly string[];
  readonly rateLimit: { readonly limiter: string } | false;
  readonly guards?: readonly Type<CanActivate>[];
  readonly ports: NonNullable<BackOfficeManagementOptions['ports']>;
}

const fail = (message: string): never => {
  throw new TypeError(`[back-office/management] ${message}`);
};
const ALL_FEATURES: readonly ManagementFeature[] = [...MANAGEMENT_RECORD_FEATURES, 'creditAccounts', 'connections'];
const PATH = /^[A-Za-z0-9][A-Za-z0-9/_-]*$/;

export function resolveManagementOptions(input: BackOfficeManagementOptions = {}): ResolvedManagementOptions {
  if (!input || typeof input !== 'object') fail('options must be an object');
  const path = input.path ?? 'management';
  if (typeof path !== 'string' || !PATH.test(path) || path.includes('//')) fail(`invalid path "${String(path)}"`);
  const ports = { ...(input.ports ?? {}) };
  for (const [key, value] of Object.entries(ports))
    if (value !== undefined && typeof value !== 'function') fail(`ports.${key} must be an injectable class`);
  const features = {} as Record<ManagementFeature, boolean>;
  for (const key of Object.keys(input.features ?? {}))
    if (!ALL_FEATURES.includes(key as ManagementFeature)) fail(`unknown feature "${key}"`);
  for (const feature of ALL_FEATURES) {
    const requested = input.features?.[feature];
    if (requested !== undefined && typeof requested !== 'boolean') fail(`feature "${feature}" must be a boolean`);
    const fallback = feature === 'credits' ? false
      : feature === 'creditAccounts' ? !!(ports.credits && ports.creditLedger)
      : feature === 'connections' ? !!ports.connections : true;
    features[feature] = requested ?? fallback;
  }
  if (features.creditAccounts && (!ports.credits || !ports.creditLedger)) fail('feature "creditAccounts" needs ports.credits and ports.creditLedger');
  if (features.connections && !ports.connections) fail('feature "connections" needs ports.connections');
  const permissions = { ...DEFAULT_MANAGEMENT_PERMISSIONS };
  for (const [key, value] of Object.entries(input.permissions ?? {})) {
    if (!(key in permissions)) fail(`unknown permission key "${key}"`);
    if (typeof value !== 'string' || !value.trim()) fail(`permission "${key}" must be a non-empty string`);
    permissions[key as keyof typeof permissions] = value as string;
  }
  const origins = input.trustedOrigins ?? [];
  if (typeof origins !== 'function' && !Array.isArray(origins)) fail('trustedOrigins must be an array or a function');
  const trustedOrigins = typeof origins === 'function' ? origins : () => origins;
  const rateLimit = input.rateLimit === undefined ? { limiter: 'api-default' } : input.rateLimit;
  if (rateLimit !== false && (!rateLimit || typeof rateLimit.limiter !== 'string' || !rateLimit.limiter)) fail('rateLimit must be false or { limiter }');
  if (input.guards !== undefined && !Array.isArray(input.guards)) fail('guards must be an array');
  return Object.freeze({
    path,
    models: resolveModelNames('management', DEFAULT_MANAGEMENT_MODELS, input.models),
    tables: resolveModelNames('management', DEFAULT_MANAGEMENT_TABLES, input.tables),
    features: Object.freeze(features),
    permissions: Object.freeze(permissions),
    trustedOrigins,
    rateLimit: rateLimit === false ? false : Object.freeze({ limiter: rateLimit.limiter }),
    ...(input.guards ? { guards: Object.freeze([...input.guards]) } : {}),
    ports: Object.freeze(ports),
  });
}
