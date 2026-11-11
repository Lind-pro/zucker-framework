import type { CanActivate, InjectionToken, Type } from '@nestjs/common';
import type { ConnectionProfileDefinition } from '@zucker-framework/config/connections';
import { DATABASE_ADAPTER } from '@zucker-framework/crud';
import { resolveModelNames, type ModelNames } from '../shared/models';
import type { ConnectionEnvironmentPins } from './connection-pins';
import {
  DEFAULT_SETTINGS_MODELS, DEFAULT_SETTINGS_TABLES, type ConnectionLabelKeyResolver, type ConnectionSettingsServiceOptions,
  type PublicIntegrationsProjection, type SettingsModelKey, type SettingsTableKey,
} from './connection-settings.service';
import type { ConnectionSaveGuard } from './data-location.guard';
import { composePolicies, type PolicyDefinition } from './policy.registry';

export interface BackOfficeConnectionOptions {
  /** Composed connection profile definitions (`composeConnectionProfiles(...)`). */
  profiles: readonly ConnectionProfileDefinition[];
  /**
   * Environment-pinned fields per profile id (`true` = every field). Pinned fields are read-only in the
   * admin, rejected on save and never written to the database; their value always comes from the
   * bootstrap environment. A fully pinned profile reports `canSave: false` (`environment_pinned`).
   */
  environmentPins?: ConnectionEnvironmentPins;
  labelKeys?: ConnectionLabelKeyResolver;
  /** Per-process cache lifetime of `hot` profiles (default 30 s). */
  hotProfileCacheTtlMs?: number;
  /** Config scope of the encrypted live values (default `runtime.connections`). */
  scope?: string;
  encryptionKey?: ConnectionSettingsServiceOptions['encryptionKey'];
  /** Audit row `module` (default `runtime-settings`). */
  auditModule?: string;
  /**
   * Projection of the applied public (hot) profiles. When set, `GET <publicPath>/integrations` is mounted
   * (unauthenticated, `no-store`) and `ConnectionSettingsService.publicIntegrations()` is available.
   */
  publicIntegrations?: PublicIntegrationsProjection;
  /** Guards run before a save of their profile (for example `createDataLocationGuard`, D14). */
  saveGuards?: readonly ConnectionSaveGuard[];
}

export interface BackOfficePolicyOptions {
  /** Feature policy arrays, e.g. `[...ACCOUNT_POLICIES, ...BILLING_POLICIES]`; ids must be unique. */
  definitions: readonly PolicyDefinition[];
  /** Mount `GET <publicPath>/config` with the `public: true` fields (default true). */
  publicConfig?: boolean;
  cacheTtlMs?: number;
  /** Config scope of the saved values (default `runtime.policy`). */
  scope?: string;
  /** Audit row `module` (default `policy`). */
  auditModule?: string;
}

export type SettingsFeature = 'connections' | 'policies';

export interface BackOfficeSettingsOptions {
  /** Administrator route prefix (default `management`): `<path>/connection-settings`, `<path>/policies`. */
  path?: string;
  /** Unauthenticated route prefix (default `site/public`): `<publicPath>/integrations`, `<publicPath>/config`. */
  publicPath?: string;
  /**
   * Bootstrap environment, read once at start-up (the host never reads `process.env`). Registers
   * `SETTINGS_BASE_ENVIRONMENT`; omit it only when another settings module instance (or the consumer)
   * already provides that token globally.
   */
  environment?: () => NodeJS.ProcessEnv;
  /** Token of a database adapter with `transaction(work)` and transactional `query(sql, values)` on PostgreSQL (default `DATABASE_ADAPTER`). */
  database?: InjectionToken;
  models?: Partial<Record<SettingsModelKey, string>>;
  tables?: Partial<Record<SettingsTableKey, string>>;
  permissions?: { query?: string; update?: string };
  /** Browser origins allowed to save (exact `Origin` match; `Sec-Fetch-Site: cross-site` refused). A function is read once per controller instance. */
  trustedOrigins?: readonly string[] | (() => readonly string[]);
  /** Rate limiter on the administrator routes, keyed by user (default `{ limiter: 'api-default' }`). `false` = none. */
  rateLimit?: { limiter: string } | false;
  /** Guards of the administrator routes. Omit for `JwtAuthGuard` + `PermissionsGuard`; `[]` when equivalent guards are global. */
  guards?: Type<CanActivate>[];
  /** Register the module globally so every feature can inject the services (default true). */
  global?: boolean;
  /** Connection profiles; `false` (default) registers no connection route, service or table access. */
  connections?: BackOfficeConnectionOptions | false;
  /** Product policies; `false` (default) registers no policy route or service. */
  policies?: BackOfficePolicyOptions | false;
}

export interface ResolvedSettingsOptions {
  readonly path: string;
  readonly publicPath: string;
  readonly environment?: () => NodeJS.ProcessEnv;
  readonly database: InjectionToken;
  readonly models: ModelNames<SettingsModelKey>;
  readonly tables: ModelNames<SettingsTableKey>;
  readonly permissions: { readonly query: string; readonly update: string };
  readonly trustedOrigins: () => readonly string[];
  readonly rateLimit: { readonly limiter: string } | false;
  readonly guards?: readonly Type<CanActivate>[];
  readonly global: boolean;
  readonly connections: (Readonly<BackOfficeConnectionOptions> & { readonly saveGuards: readonly ConnectionSaveGuard[] }) | false;
  readonly policies: (Readonly<BackOfficePolicyOptions> & { readonly publicConfig: boolean }) | false;
}

const fail = (message: string): never => { throw new TypeError(`[back-office/settings] ${message}`); };
const PATH = /^[A-Za-z0-9][A-Za-z0-9/_-]*$/;
const PERMISSION = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

function routePath(name: string, value: unknown, fallback: string): string {
  const path = value ?? fallback;
  if (typeof path !== 'string' || !PATH.test(path) || path.includes('//') || path.endsWith('/')) fail(`invalid ${name} "${String(path)}"`);
  return path as string;
}

/** Validates options at `forRoot` time, applies defaults and freezes the result. */
export function resolveSettingsOptions(input: BackOfficeSettingsOptions = {}): ResolvedSettingsOptions {
  if (!record(input)) fail('options must be an object');
  const path = routePath('path', input.path, 'management'), publicPath = routePath('publicPath', input.publicPath, 'site/public');
  if (input.environment !== undefined && typeof input.environment !== 'function') fail('environment must be a function returning the bootstrap environment');
  const permissions = { query: input.permissions?.query ?? 'config:query', update: input.permissions?.update ?? 'config:update' };
  for (const [key, value] of Object.entries(permissions)) if (typeof value !== 'string' || !PERMISSION.test(value)) fail(`invalid permission ${key} "${String(value)}"`);
  const origins = input.trustedOrigins ?? [];
  if (typeof origins !== 'function' && !Array.isArray(origins)) fail('trustedOrigins must be an array or a function');
  const rateLimit = input.rateLimit === undefined ? { limiter: 'api-default' } : input.rateLimit;
  if (rateLimit !== false && (!record(rateLimit) || typeof rateLimit.limiter !== 'string' || !rateLimit.limiter)) fail('rateLimit must be false or { limiter }');
  if (input.guards !== undefined && !Array.isArray(input.guards)) fail('guards must be an array of guard classes');

  let connections: ResolvedSettingsOptions['connections'] = false;
  if (input.connections !== undefined && input.connections !== false) {
    const value = input.connections;
    if (!record(value) || !Array.isArray(value.profiles) || !value.profiles.length) fail('connections.profiles must be a non-empty array');
    if (value.publicIntegrations !== undefined && typeof value.publicIntegrations !== 'function') fail('connections.publicIntegrations must be a function');
    const saveGuards = value.saveGuards ?? [];
    if (!Array.isArray(saveGuards) || saveGuards.some(guard => !record(guard) || typeof guard.profileId !== 'string' || typeof guard.check !== 'function'))
      fail('connections.saveGuards must be an array of { profileId, check }');
    for (const guard of saveGuards) if (!value.profiles.some(row => row.profile.id === guard.profileId)) fail(`connections.saveGuards names unknown profile "${guard.profileId}"`);
    connections = Object.freeze({ ...value, saveGuards: Object.freeze([...saveGuards]) });
  }
  let policies: ResolvedSettingsOptions['policies'] = false;
  if (input.policies !== undefined && input.policies !== false) {
    const value = input.policies;
    if (!record(value) || !Array.isArray(value.definitions)) fail('policies.definitions must be an array');
    policies = Object.freeze({ ...value, definitions: composePolicies(value.definitions), publicConfig: value.publicConfig !== false });
  }
  return Object.freeze({
    path, publicPath, environment: input.environment, database: input.database ?? DATABASE_ADAPTER,
    models: resolveModelNames('settings', DEFAULT_SETTINGS_MODELS, input.models),
    tables: resolveModelNames('settings', DEFAULT_SETTINGS_TABLES, input.tables),
    permissions: Object.freeze(permissions),
    trustedOrigins: typeof origins === 'function' ? origins : () => origins,
    rateLimit: rateLimit === false ? false : Object.freeze({ limiter: (rateLimit as { limiter: string }).limiter }),
    guards: input.guards ? Object.freeze([...input.guards]) : undefined,
    global: input.global !== false,
    connections, policies,
  });
}

/** Service options derived from the resolved module options. */
export function connectionServiceOptions(options: ResolvedSettingsOptions): ConnectionSettingsServiceOptions {
  const connections = options.connections;
  if (!connections) throw new TypeError('[back-office/settings] connections are disabled');
  return {
    profiles: connections.profiles, environmentPins: connections.environmentPins, labelKeys: connections.labelKeys,
    hotProfileCacheTtlMs: connections.hotProfileCacheTtlMs, scope: connections.scope, encryptionKey: connections.encryptionKey,
    models: options.models, tables: options.tables, publicIntegrations: connections.publicIntegrations,
    audit: { module: connections.auditModule, path: `/${options.path}/connection-settings` },
  };
}
