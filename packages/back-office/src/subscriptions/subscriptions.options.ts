import type { CanActivate, DynamicModule, ForwardReference, InjectionToken, OptionalFactoryDependency, Type } from '@nestjs/common';
import type { EntitlementCatalog, EntitlementCounterDefinition, EntitlementFeatureDefinition } from '@zucker-framework/credit';
import { resolveSubscriptionsStorage, type SubscriptionsStorage, type SubscriptionsStorageInput } from './storage';
import type { SubscriptionsViewer } from './subscriptions.ports';

/** Feature with optional presentation; `label` and `description` fall back to the key. */
export interface PresentedEntitlementFeature extends EntitlementFeatureDefinition {
  label?: string;
  description?: string;
}
/** Counter with optional presentation; `label` falls back to the key, `unit` to an empty string. */
export interface PresentedEntitlementCounter extends EntitlementCounterDefinition {
  label?: string;
  unit?: string;
}
export type PresentedEntitlementCatalog = EntitlementCatalog<PresentedEntitlementFeature, PresentedEntitlementCounter>;

/** Values read on every use (`settings`), so a runtime configuration source can change them without a restart. */
export interface SubscriptionsSettings {
  /** IANA zone of month/day counter periods. Default `UTC`. */
  timeZone: string;
  /** Lifetime of a metered-feature reservation, 1 s – 24 h. Default 15 minutes. */
  reservationTtlMs: number;
}
export type SubscriptionsSettingsResolver = () => SubscriptionsSettings;
export interface SubscriptionsSettingsFactory {
  inject?: Array<InjectionToken | OptionalFactoryDependency>;
  useFactory: (...args: never[]) => SubscriptionsSettingsResolver | Partial<SubscriptionsSettings>;
}

/** Route groups; a disabled one registers no route. `quota: false` additionally touches no quota table. */
export interface SubscriptionsFeatures {
  /** `GET <publicPath>/plans|currencies|entitlements/catalog|entitlements/me`. Default on. */
  publicRoutes: boolean;
  /** `management/plans*` (createPlanAdminController). Default on. */
  planAdmin: boolean;
  /** `management/subscriptions*` (createUserSubscriptionAdminController). Default on. */
  subscriptionAdmin: boolean;
  /** `management/quota-usage`, `management/quota-reservations*`. Default on (needs `quota`). */
  quotaAdmin: boolean;
  /** Metered features (`chargeResource`), counter snapshots and their tables. Default on. */
  quota: boolean;
  /** Plans are checkout offers and paid orders write the plan term back (needs `billing`). Default on. */
  paymentWriteBack: boolean;
}

export interface SubscriptionsPaths {
  /** Public routes prefix. Default `billing`. */
  public: string;
  plans: string;
  subscriptions: string;
  quotaUsage: string;
  quotaReservations: string;
}

export interface BackOfficeSubscriptionsOptions extends SubscriptionsStorageInput {
  /** The product's entitlement catalog (features, counters, labels). Plans are validated against it. */
  catalog: PresentedEntitlementCatalog;
  features?: Partial<SubscriptionsFeatures>;
  paths?: Partial<SubscriptionsPaths>;
  /** Static values, or a factory that may inject a runtime configuration source. */
  settings?: Partial<SubscriptionsSettings> | SubscriptionsSettingsFactory;
  /**
   * Token of the billing integration ({@link SubscriptionsBillingPort}), e.g. the billing service class;
   * registered with `useExisting`, so the module providing it must be in `imports`. Without it prices
   * are never purchasable, there are no credit packs and no payment write-back.
   */
  billing?: InjectionToken;
  /** Optional bearer on `GET /plans` marks the caller's current plan; without it every caller is anonymous. */
  viewer?: Type<SubscriptionsViewer>;
  /** Modules providing `billing`, `viewer` dependencies, etc. */
  imports?: Array<Type<unknown> | DynamicModule | Promise<DynamicModule> | ForwardReference>;
  /** Omit for `JwtAuthGuard` + `PermissionsGuard`; `[]` when equivalent guards are global. */
  guards?: Type<CanActivate>[];
  /** Overrides of the admin factories' permission codes. */
  permissions?: {
    plans?: Partial<{ query: string; add: string; update: string; delete: string }>;
    subscriptions?: Partial<{ query: string; update: string }>;
    quota?: Partial<{ query: string; update: string }>;
  };
  /**
   * In-process event name emitted (after commit, through `@nestjs/event-emitter` when present) for
   * administrator assignments and cancellations. Default `subscriptions.changed`.
   */
  changeEvent?: string;
}

export interface ResolvedSubscriptionsOptions {
  catalog: PresentedEntitlementCatalog;
  storage: SubscriptionsStorage;
  features: Readonly<SubscriptionsFeatures>;
  paths: Readonly<SubscriptionsPaths>;
  settings: Partial<SubscriptionsSettings> | SubscriptionsSettingsFactory;
  billing?: InjectionToken;
  viewer?: Type<SubscriptionsViewer>;
  imports: NonNullable<BackOfficeSubscriptionsOptions['imports']>;
  guards?: Type<CanActivate>[];
  permissions: NonNullable<BackOfficeSubscriptionsOptions['permissions']>;
  changeEvent: string;
}

export const DEFAULT_SUBSCRIPTIONS_SETTINGS: Readonly<SubscriptionsSettings> = Object.freeze({ timeZone: 'UTC', reservationTtlMs: 900_000 });
export const DEFAULT_SUBSCRIPTIONS_PATHS: Readonly<SubscriptionsPaths> = Object.freeze({
  public: 'billing',
  plans: 'management/plans',
  subscriptions: 'management/subscriptions',
  quotaUsage: 'management/quota-usage',
  quotaReservations: 'management/quota-reservations',
});
const DEFAULT_FEATURES: Readonly<SubscriptionsFeatures> = Object.freeze({
  publicRoutes: true, planAdmin: true, subscriptionAdmin: true, quotaAdmin: true, quota: true, paymentWriteBack: true,
});
export const SUBSCRIPTION_CHANGED_EVENT = 'subscriptions.changed';

function fail(message: string): never {
  throw new TypeError(`[back-office/subscriptions] ${message}`);
}
function plainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Validates and completes settings read at runtime; invalid values throw instead of silently changing quotas. */
export function resolveSubscriptionsSettings(input: Partial<SubscriptionsSettings> | undefined): SubscriptionsSettings {
  const timeZone = input?.timeZone ?? DEFAULT_SUBSCRIPTIONS_SETTINGS.timeZone;
  const reservationTtlMs = input?.reservationTtlMs ?? DEFAULT_SUBSCRIPTIONS_SETTINGS.reservationTtlMs;
  if (typeof timeZone !== 'string' || !timeZone.trim()) fail('settings.timeZone must be an IANA time zone');
  const zone = timeZone.trim();
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); } catch { fail(`settings.timeZone "${zone}" is not a known time zone`); }
  if (!Number.isSafeInteger(reservationTtlMs) || reservationTtlMs < 1000 || reservationTtlMs > 86_400_000)
    fail('settings.reservationTtlMs must be an integer between 1000 and 86400000');
  return Object.freeze({ timeZone: zone, reservationTtlMs });
}

export function resolveSubscriptionsOptions(input: BackOfficeSubscriptionsOptions): ResolvedSubscriptionsOptions {
  if (!plainObject(input)) fail('options must be an object');
  const catalog = input.catalog;
  if (!plainObject(catalog) || !Array.isArray(catalog.features) || !Array.isArray(catalog.counters))
    fail('catalog must declare features and counters');
  const features = { ...DEFAULT_FEATURES };
  for (const [key, value] of Object.entries(input.features ?? {})) {
    if (!(key in DEFAULT_FEATURES)) fail(`unknown feature "${key}"`);
    if (value === undefined) continue;
    if (typeof value !== 'boolean') fail(`feature "${key}" must be a boolean`);
    features[key as keyof SubscriptionsFeatures] = value;
  }
  if (!features.quota) features.quotaAdmin = false;
  const paths = { ...DEFAULT_SUBSCRIPTIONS_PATHS };
  for (const [key, value] of Object.entries(input.paths ?? {})) {
    if (!(key in DEFAULT_SUBSCRIPTIONS_PATHS)) fail(`unknown path "${key}"`);
    if (value === undefined) continue;
    if (typeof value !== 'string' || !/^[A-Za-z0-9_\-/:]+$/.test(value)) fail(`path "${key}" must be a route path`);
    paths[key as keyof SubscriptionsPaths] = value.replace(/^\/+|\/+$/g, '');
  }
  const settings = input.settings ?? {};
  if (!plainObject(settings)) fail('settings must be an object');
  // Static settings fail at startup; a factory's result is validated when the module is built.
  if (typeof (settings as SubscriptionsSettingsFactory).useFactory !== 'function')
    resolveSubscriptionsSettings(settings as Partial<SubscriptionsSettings>);
  if (input.guards !== undefined && !Array.isArray(input.guards)) fail('guards must be an array of guard classes');
  if (input.changeEvent !== undefined && (typeof input.changeEvent !== 'string' || !input.changeEvent.trim()))
    fail('changeEvent must be a non-empty string');
  return Object.freeze({
    catalog,
    storage: resolveSubscriptionsStorage(input),
    features: Object.freeze(features),
    paths: Object.freeze(paths),
    settings,
    ...(input.billing !== undefined ? { billing: input.billing } : {}),
    ...(input.viewer !== undefined ? { viewer: input.viewer } : {}),
    imports: [...(input.imports ?? [])],
    ...(input.guards !== undefined ? { guards: [...input.guards] } : {}),
    permissions: input.permissions ?? {},
    changeEvent: input.changeEvent ?? SUBSCRIPTION_CHANGED_EVENT,
  });
}
