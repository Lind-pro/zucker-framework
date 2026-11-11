import type { CanActivate, InjectionToken, ModuleMetadata, Type } from '@nestjs/common';
import type { RateLimit } from '@zucker-framework/rate-limiter';
import { BillingStorage, type BillingAccountLock, type BillingModelKey, type BillingTableKey } from './billing.database';
import { billingPersistenceConfig, type BillingPersistenceConfig } from './billing.config';
import type {
  BillingCheckoutHooks, BillingCheckoutPolicyValues, BillingCredits, BillingReferrals, BillingRefundHooks,
} from './billing.ports';
import type { BillingRuntimeSource, BillingService } from './billing.service';
import type { PaymentCredentialArchive, PaymentCredentialOperatorCheck } from './payment-credential-retention';
import type { PaymentProfileMap } from './payment-credentials';
import type { FakePaymentLedger } from './test-fakes/fake-payment-provider';

type RateLimitSetting = Parameters<typeof RateLimit>[0];

/** A class with `values()` returning the checkout provider policy (registered with `useClass`, so it can inject). */
export interface BillingCheckoutPolicyProvider { values(): Promise<BillingCheckoutPolicyValues> }

export const BILLING_FEATURES = ['orders', 'subscriptions', 'refunds', 'recovery', 'paymentCredentials', 'creditPacks', 'testCheckout'] as const;
export type BillingFeature = (typeof BILLING_FEATURES)[number];

export const DEFAULT_BILLING_PATHS = Object.freeze({
  billing: 'billing',
  subscriptions: 'billing/subscriptions',
  refunds: 'billing/refunds',
  recovery: 'management/orders',
  paymentCredentials: 'management/payment-credentials',
  creditPacks: 'management/credit-packs',
  testCheckout: 'billing/test-checkout',
});
export const DEFAULT_BILLING_PERMISSIONS = Object.freeze({
  refund: 'billing:refund',
  recover: 'billing:refund',
  paymentCredentials: 'config:update',
});

export interface BackOfficeBillingOptions {
  /** Modules the external service and the port classes need. */
  imports?: ModuleMetadata['imports'];
  /**
   * An existing {@link BillingService} (a subclass the consumer registers, resolvable through
   * `imports`). When absent the module constructs one from `runtime` and the options below.
   */
  service?: InjectionToken;
  /** Provider instances, static catalog and site URL (required unless `service` is given). */
  runtime?: { inject?: InjectionToken[]; useFactory: (...args: never[]) => BillingRuntimeSource | Promise<BillingRuntimeSource> };
  /** Database adapter token (default `DATABASE_ADAPTER`). */
  database?: InjectionToken;
  models?: Partial<Record<BillingModelKey, string>>;
  tables?: Partial<Record<BillingTableKey, string>>;
  /** Account lock shared by every billing writer (default: the credit ledger's lock; see `advisoryAccountLock` for plans-only). */
  lockAccount?: BillingAccountLock;
  /** Credit ledger; omit (or null) for plans-only billing. */
  credits?: BillingCredits | null;
  referrals?: BillingReferrals | null;
  ports?: {
    checkout?: Type<BillingCheckoutHooks>;
    refunds?: Type<BillingRefundHooks>;
    policy?: Type<BillingCheckoutPolicyProvider>;
    /** Archive of saved payment revisions (needed by `features.paymentCredentials`). */
    credentialArchive?: Type<PaymentCredentialArchive> | { token: InjectionToken };
  };
  /** Provider return URLs and portal return path (see `BillingServiceConfig`). */
  returnUrls?(orderId: string, webUrl: URL): { successUrl: string; cancelUrl: string };
  portalReturnPath?: string;
  /** Exact browser origins allowed to change state. */
  trustedOrigins: () => readonly string[];
  /** Default `[JwtAuthGuard, PermissionsGuard]`; `[]` with global guards. */
  guards?: Type<CanActivate>[];
  /** Per-user limiter (default `'billing'`, `false` none) and webhook limiter (default `'billing-webhook'`). */
  rateLimit?: RateLimitSetting | false;
  webhookRateLimit?: RateLimitSetting | false;
  paths?: Partial<typeof DEFAULT_BILLING_PATHS>;
  permissions?: Partial<typeof DEFAULT_BILLING_PERMISSIONS>;
  /**
   * Routes per feature. Defaults: orders, subscriptions, refunds, recovery on; paymentCredentials,
   * creditPacks (needs `credits`), testCheckout off. A disabled feature registers no route.
   */
  features?: Partial<Record<BillingFeature, boolean>>;
  /** D13 purge: retention (days, min 400), known profiles and operator check. */
  paymentCredentials?: { retentionDays?: number; profiles?: PaymentProfileMap; operator?: PaymentCredentialOperatorCheck };
  /** TEST-ONLY checkout page: how to find the fake ledger. Required when `features.testCheckout`. */
  testCheckout?: { ledger: (billing: BillingService, source: unknown) => FakePaymentLedger | null; ledgerSource?: InjectionToken; assertAllowed?: () => void };
}

export interface ResolvedBillingOptions extends Omit<BackOfficeBillingOptions, 'features' | 'paths' | 'permissions' | 'models' | 'tables' | 'lockAccount' | 'credits'> {
  readonly persistence: BillingPersistenceConfig;
  readonly features: Readonly<Record<BillingFeature, boolean>>;
  readonly paths: Readonly<typeof DEFAULT_BILLING_PATHS>;
  readonly permissions: Readonly<typeof DEFAULT_BILLING_PERMISSIONS>;
}

function fail(message: string): never { throw new TypeError(`[back-office/billing] ${message}`); }

/** Validates options, applies defaults and freezes them (misconfiguration fails at startup). */
export function resolveBillingOptions(input: BackOfficeBillingOptions): ResolvedBillingOptions {
  if (!input || typeof input !== 'object') fail('options are required');
  if (typeof input.trustedOrigins !== 'function') fail('trustedOrigins must be a function');
  if (!input.service && !input.runtime) fail('either service or runtime is required');
  if (input.runtime && typeof input.runtime.useFactory !== 'function') fail('runtime.useFactory must be a function');
  for (const key of Object.keys(input.features ?? {})) if (!(BILLING_FEATURES as readonly string[]).includes(key)) fail(`unknown feature "${key}"`);
  for (const key of Object.keys(input.paths ?? {})) if (!Object.hasOwn(DEFAULT_BILLING_PATHS, key)) fail(`unknown path "${key}"`);
  for (const key of Object.keys(input.permissions ?? {})) if (!Object.hasOwn(DEFAULT_BILLING_PERMISSIONS, key)) fail(`unknown permission "${key}"`);
  const paths = { ...DEFAULT_BILLING_PATHS, ...input.paths };
  for (const [key, value] of Object.entries(paths)) if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9/_-]*$/i.test(value)) fail(`path "${key}" is invalid`);
  const permissions = { ...DEFAULT_BILLING_PERMISSIONS, ...input.permissions };
  for (const [key, value] of Object.entries(permissions)) if (typeof value !== 'string' || !/^[a-z0-9-]+:[a-z0-9-]+$/i.test(value)) fail(`permission "${key}" is invalid`);
  const features: Record<BillingFeature, boolean> = { orders: true, subscriptions: true, refunds: true, recovery: true,
    paymentCredentials: false, creditPacks: false, testCheckout: false };
  for (const [key, value] of Object.entries(input.features ?? {})) {
    if (typeof value !== 'boolean') fail(`feature "${key}" must be a boolean`);
    features[key as BillingFeature] = value;
  }
  const persistence = billingPersistenceConfig({
    storage: new BillingStorage({ models: input.models, tables: input.tables, lockAccount: input.lockAccount }),
    // Explicit `null` (plans-only) is checked there; an external `service` brings its own persistence.
    credits: input.service ? input.credits : input.credits ?? null,
  });
  if (features.creditPacks && !persistence.credits) fail('creditPacks needs a credit ledger (credits)');
  if (features.testCheckout && typeof input.testCheckout?.ledger !== 'function') fail('testCheckout needs testCheckout.ledger');
  if (features.paymentCredentials && !input.ports?.credentialArchive && !input.service)
    fail('paymentCredentials needs ports.credentialArchive');
  const { features: _f, paths: _p, permissions: _r, models: _m, tables: _t, lockAccount: _l, credits: _c, ...rest } = input;
  return Object.freeze({ ...rest, persistence, features: Object.freeze(features), paths: Object.freeze(paths), permissions: Object.freeze(permissions) });
}
