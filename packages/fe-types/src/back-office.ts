/**
 * Back-office wire contract (docs/back-office-rfc.md §8): request/response shapes shared by the
 * server-side factories (`@zucker-framework/admin`), the domain ports (`payment`, `credit`) and the
 * browser pages (`@zucker-framework/fe-admin`). Browser-safe and dependency-free; dates are ISO
 * strings on the wire and `Date` objects in server-side records (`TDate`).
 */

// ─── Port errors ─────────────────────────────────────────────────────────────

/** Every reason a back-office domain port may reject with. Admin maps each to one HTTP status. */
export const PORT_ERROR_REASONS = [
  'invalid',
  'not_found',
  'conflict',
  'referenced',
  'pending_payment',
  'inactive',
  'in_progress',
  'unavailable',
] as const;
export type PortErrorReason = (typeof PORT_ERROR_REASONS)[number];

/** HTTP status for each port reason. */
export const PORT_ERROR_STATUS: Readonly<Record<PortErrorReason, 400 | 404 | 409 | 503>> = Object.freeze({
  invalid: 400,
  not_found: 404,
  conflict: 409,
  referenced: 409,
  pending_payment: 409,
  inactive: 409,
  in_progress: 409,
  unavailable: 503,
});

/**
 * Brand set on domain errors that admin may translate to HTTP. A registered symbol, so separate
 * copies of the packages still recognize each other; foreign errors that merely carry a `reason`
 * property are never translated.
 */
export const PORT_ERROR = Symbol.for('@zucker-framework/port-error');

export interface PortErrorShape {
  readonly reason: PortErrorReason;
  readonly message: string;
  readonly issues?: readonly string[];
  /** Safe, client-facing details (for example the payment that blocks an assignment). */
  readonly details?: Readonly<Record<string, unknown>>;
}

/** Marks an error instance as a port error with the given reason. Returns the same instance. */
export function brandPortError<E extends Error & { reason: PortErrorReason }>(error: E): E {
  Object.defineProperty(error, PORT_ERROR, { value: true, enumerable: false });
  return error;
}

export function isPortErrorReason(value: unknown): value is PortErrorReason {
  return typeof value === 'string' && (PORT_ERROR_REASONS as readonly string[]).includes(value);
}

/** True for branded port errors with a known reason. */
export function isPortError(error: unknown): error is Error & PortErrorShape {
  return (
    error instanceof Error &&
    (error as unknown as Record<symbol, unknown>)[PORT_ERROR] === true &&
    isPortErrorReason((error as { reason?: unknown }).reason)
  );
}

/**
 * Body of a 4xx response produced from a port error by `@zucker-framework/admin`. Hosts that use the
 * `@zucker-framework/common` HttpExceptionFilter receive it as `{ status, code: reason, message,
 * result: { reason, issues?, details? } }`; use {@link readPortError} to read either shape.
 */
export interface PortErrorBody {
  statusCode: number;
  message: string;
  /** Same as `reason`; kept as `code` so envelope filters preserve it. */
  code: PortErrorReason;
  reason: PortErrorReason;
  issues?: string[];
  details?: Record<string, unknown>;
}

export interface PortErrorView {
  reason?: PortErrorReason;
  message?: string;
  issues?: string[];
  details?: Record<string, unknown>;
}

/** Reads a port error from a raw body or from the common `{ status, code, message, result }` envelope. */
export function readPortError(body: unknown): PortErrorView {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return {};
  const raw = body as Record<string, unknown>;
  const nested = raw.result && typeof raw.result === 'object' && !Array.isArray(raw.result) ? (raw.result as Record<string, unknown>) : {};
  const pick = (key: string) => (raw[key] !== undefined ? raw[key] : nested[key]);
  const reason = [pick('reason'), raw.code].find(isPortErrorReason);
  const issues = pick('issues');
  const details = pick('details');
  return {
    ...(reason ? { reason } : {}),
    ...(typeof raw.message === 'string' ? { message: raw.message } : {}),
    ...(Array.isArray(issues) ? { issues: issues.filter((item): item is string => typeof item === 'string') } : {}),
    ...(details && typeof details === 'object' && !Array.isArray(details) ? { details: details as Record<string, unknown> } : {}),
  };
}

// ─── Pages ───────────────────────────────────────────────────────────────────

export interface BackOfficePage<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages?: number;
}

// ─── Entitlements (§8.1) ─────────────────────────────────────────────────────

export type EntitlementPeriod = 'month' | 'day' | 'lifetime';
export type EntitlementCategory = 'metered' | 'benefit';

export interface EntitlementCatalogFeature {
  key: string;
  label: string;
  /** Stable translation key; clients translate by key and fall back to `label`. */
  labelKey?: string;
  description?: string;
  category: EntitlementCategory;
  counter?: string;
}
export interface EntitlementCatalogCounter {
  key: string;
  label: string;
  labelKey?: string;
  unit?: string;
  period: EntitlementPeriod;
}
export interface EntitlementCatalogResponse {
  features: EntitlementCatalogFeature[];
  counters: EntitlementCatalogCounter[];
}

/** One counter in its current period; `-1` limit/remaining means unlimited. */
export interface QuotaSnapshot {
  limit: number;
  used: number;
  reserved: number;
  remaining: number;
  period: string;
}

export interface PlanSummary {
  id: string;
  slug: string;
  name: string;
}

export interface EntitlementsMe {
  active: boolean;
  plan: PlanSummary | null;
  status: UserSubscriptionStatus | null;
  validUntil: string | null;
  features: Record<string, boolean>;
  quotas: Record<string, QuotaSnapshot>;
}

// ─── Plans (§8.2) ────────────────────────────────────────────────────────────

/**
 * `month`/`year` renew through a provider subscription; `one_time` is one payment for `termDays`
 * of access; `lifetime` is one payment with no end.
 */
export const PLAN_PRICE_INTERVALS = ['month', 'year', 'one_time', 'lifetime'] as const;
export type PlanPriceInterval = (typeof PLAN_PRICE_INTERVALS)[number];
export const RECURRING_PLAN_PRICE_INTERVALS: readonly PlanPriceInterval[] = ['month', 'year'];

/**
 * Lifetime of the credits a plan price grants: `'period'` expires them at the end of the paid period
 * (one-time term end, subscription cycle end; never for `lifetime`), a number is days after the
 * grant, `null` never expires.
 */
export type PlanCreditExpiry = 'period' | number | null;
export const MAX_PLAN_PRICE_CREDITS = 2_147_483_647;
export const MAX_CREDIT_EXPIRY_DAYS = 36_500;

/** One price of a plan. Unique per plan by (interval, currency). */
export interface PlanPrice {
  interval: PlanPriceInterval;
  /** ISO 4217 code, uppercase. */
  currency: string;
  /** Exact decimal string in major units, formatted for the currency ("19.90"). Never a float. */
  amount: string;
  /** Days of access for `one_time`; null for every other interval. */
  termDays: number | null;
  /** Payment provider id → that provider's catalog reference (for example a Stripe Price ID). */
  providerRefs: Record<string, string>;
  /**
   * Credits granted with each paid period (each renewal for month/year, once for one-time/lifetime).
   * Always present in server responses; omitted in a write means 0.
   */
  credits?: number;
  /** Expiry of those credits; always present in server responses; omitted in a write means null. */
  creditExpiry?: PlanCreditExpiry;
}

/** Locale tag (`en`, `zh`, `pt-BR`) → localized text. Missing locales fall back to the base field. */
export type LocalizedText = Record<string, string>;
export const MAX_PLAN_HIGHLIGHTS = 12;
export const MAX_PLAN_HIGHLIGHT_LENGTH = 200;

/** Plan record as stored and as returned by `/management/plans`. */
export interface SubscriptionPlan<TDate = string> {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  /** Listed (true) or draft/unlisted (false). */
  status: boolean;
  order: number;
  features: Record<string, boolean>;
  quotas: Record<string, number>;
  prices: PlanPrice[];
  /** Presentation (always present in server responses): emphasised card on the pricing page. */
  featured?: boolean;
  /** Short label on the card ("Most popular"), or null. */
  badge?: string | null;
  /** Bullet points of the card (at most 12, 200 characters each). */
  highlights?: string[];
  nameI18n?: LocalizedText;
  descriptionI18n?: LocalizedText;
  badgeI18n?: LocalizedText;
  /** Locale → complete localized highlight list (replaces `highlights` for that locale). */
  highlightsI18n?: Record<string, string[]>;
  /** Incremented by every write; send it back as `expectedRevision` to detect concurrent edits. */
  revision: number;
  createdAt: TDate;
  updatedAt: TDate;
}

/** Body of `POST /management/plans` and `PUT /management/plans/:id` (PUT fields are optional). */
export interface SubscriptionPlanWriteBody {
  slug?: string;
  name?: string;
  description?: string | null;
  status?: boolean;
  order?: number;
  features?: Record<string, boolean>;
  quotas?: Record<string, number>;
  /** Replaces the whole price list when present. Amounts must be decimal strings. */
  prices?: PlanPrice[];
  featured?: boolean;
  badge?: string | null;
  highlights?: string[];
  nameI18n?: LocalizedText;
  descriptionI18n?: LocalizedText;
  badgeI18n?: LocalizedText;
  highlightsI18n?: Record<string, string[]>;
  /** PUT only: rejects with 409 when the plan changed since this revision was read. */
  expectedRevision?: number;
}

/** One price in `GET /billing/plans`; provider references are never exposed. */
export interface PublicPlanPrice {
  interval: PlanPriceInterval;
  currency: string;
  amount: string;
  termDays: number | null;
  /** Checkout offer id (`POST /billing/checkout`), or null when nothing can sell this price. */
  offerId: string | null;
  purchasable: boolean;
  /** Provider ids that can sell this price now. */
  providers: string[];
  /** Credits granted per paid period (0 = none). */
  credits: number;
  creditExpiry: PlanCreditExpiry;
}
export interface PublicPlan {
  id: string;
  slug: string;
  /** Localized for `?locale=` when the plan has a translation, else the base text. */
  name: string;
  description: string | null;
  order: number;
  features: Record<string, boolean>;
  quotas: Record<string, number>;
  prices: PublicPlanPrice[];
  featured: boolean;
  badge: string | null;
  highlights: string[];
  /** True when the authenticated caller's current, active plan term is this plan (false for guests). */
  current: boolean;
}

// ─── Credit packs ────────────────────────────────────────────────────────────

/** One price of a credit pack (one-time payment). Unique per pack by currency. */
export interface CreditPackPrice {
  currency: string;
  /** Exact decimal string in major units, formatted for the currency. */
  amount: string;
  /** Payment provider id → catalog reference that sells this price. */
  providerRefs: Record<string, string>;
}

/** Credit pack as stored and as returned by `/management/credit-packs`. */
export interface CreditPack<TDate = string> {
  id: string;
  slug: string;
  title: string;
  titleI18n: LocalizedText;
  description: string | null;
  descriptionI18n: LocalizedText;
  /** Credits granted per purchase (1 … 2147483647). */
  credits: number;
  /** Days until the granted credits expire; null never expires. */
  expiresInDays: number | null;
  /** Listed (true) or draft/unlisted (false). */
  status: boolean;
  order: number;
  prices: CreditPackPrice[];
  /** Incremented by every write; send it back as `expectedRevision` to detect concurrent edits. */
  revision: number;
  createdAt: TDate;
  updatedAt: TDate;
}

/** Body of `POST /management/credit-packs` and `PUT /management/credit-packs/:id` (PUT fields optional). */
export interface CreditPackWriteBody {
  slug?: string;
  title?: string;
  titleI18n?: LocalizedText;
  description?: string | null;
  descriptionI18n?: LocalizedText;
  credits?: number;
  expiresInDays?: number | null;
  status?: boolean;
  order?: number;
  /** Replaces the whole price list when present. */
  prices?: CreditPackPrice[];
  /** PUT only: 409 when the pack changed since this revision was read. */
  expectedRevision?: number;
}

export interface PublicCreditPackPrice {
  currency: string;
  amount: string;
  /** Checkout offer id (`POST /billing/orders`), or null when nothing can sell this price. */
  offerId: string | null;
  purchasable: boolean;
  providers: string[];
}
export interface PublicCreditPack {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  credits: number;
  expiresInDays: number | null;
  order: number;
  prices: PublicCreditPackPrice[];
}

/** Checkout provider choice (the `billing` product policy). */
export interface PublicBillingCheckoutPolicy {
  /** Provider preselected (or the only one used when choice is off); null = first available. */
  defaultProvider: string | null;
  allowProviderChoice: boolean;
}

/** `GET /billing/plans[?currency=USD][&locale=en]`. */
export interface PublicPricingCatalog {
  plans: PublicPlan[];
  packs: PublicCreditPack[];
  checkout: PublicBillingCheckoutPolicy;
}

/** `GET /billing/currencies`: every currency with at least one listed plan or pack price. */
export interface PublicBillingCurrencies {
  currencies: string[];
  /** Suggested default: the most common currency among listed prices, or null when none. */
  default: string | null;
}

// ─── User subscriptions (§8.3) ───────────────────────────────────────────────

/**
 * Stored status. Expiry is derived (`active`), never swept: an ACTIVE or CANCELED row whose end has
 * passed reports `active: false`. `EXPIRED` is written only when an administrator revokes a term.
 */
export const USER_SUBSCRIPTION_STATUSES = ['ACTIVE', 'CANCELED', 'EXPIRED'] as const;
export type UserSubscriptionStatus = (typeof USER_SUBSCRIPTION_STATUSES)[number];
export const USER_SUBSCRIPTION_CYCLES = ['MONTHLY', 'YEARLY', 'ONE_TIME', 'LIFETIME'] as const;
export type UserSubscriptionCycle = (typeof USER_SUBSCRIPTION_CYCLES)[number];
export const USER_SUBSCRIPTION_SOURCES = ['admin', 'payment'] as const;
export type UserSubscriptionSource = (typeof USER_SUBSCRIPTION_SOURCES)[number];
/** List filter on the derived validity, independent of the stored status. */
export const USER_SUBSCRIPTION_ACTIVITY = ['active', 'inactive'] as const;
export type UserSubscriptionActivity = (typeof USER_SUBSCRIPTION_ACTIVITY)[number];

/** Billing cycle written for a paid plan price interval. */
export const CYCLE_FOR_INTERVAL: Readonly<Record<PlanPriceInterval, UserSubscriptionCycle>> = Object.freeze({
  month: 'MONTHLY',
  year: 'YEARLY',
  one_time: 'ONE_TIME',
  lifetime: 'LIFETIME',
});

export interface UserSubscriptionRow<TDate = string> {
  id: string;
  userId: string;
  status: UserSubscriptionStatus;
  billingCycle: UserSubscriptionCycle;
  startDate: TDate;
  endDate: TDate | null;
  cancelAtPeriodEnd: boolean;
  canceledAt: TDate | null;
  source: UserSubscriptionSource;
  /** Derived validity at response time. */
  active: boolean;
  createdAt: TDate;
  updatedAt: TDate;
  user: { id: string; username: string; email: string | null } | null;
  plan: PlanSummary | null;
}

/** `GET/PUT/DELETE /management/subscriptions/:userId`: the row plus effective entitlements. */
export interface UserSubscriptionDetail<TDate = string> extends UserSubscriptionRow<TDate> {
  features: Record<string, boolean>;
  quotas: Record<string, QuotaSnapshot>;
}

/**
 * Body of `PUT /management/subscriptions/:userId`. Omit `startDate`/`endDate` to keep the current
 * term's dates (or derive them for a new term); LIFETIME never has an end date.
 */
export interface UserSubscriptionAssignmentBody {
  planSlug: string;
  billingCycle: UserSubscriptionCycle;
  status?: UserSubscriptionStatus;
  startDate?: string;
  endDate?: string | null;
}

/** `details` of a 409 `pending_payment`: the billing record that must be settled first. */
export interface PendingPaymentDetails {
  blocking: { kind: 'order' | 'subscription'; id: string; state: string };
}

// ─── Quota (§8.4) ────────────────────────────────────────────────────────────

export const QUOTA_RESERVATION_STATES = ['RESERVED', 'CONFIRMED', 'RELEASED', 'EXPIRED'] as const;
export type QuotaReservationStatus = (typeof QUOTA_RESERVATION_STATES)[number];

export interface QuotaUsageRow<TDate = string> {
  userId: string;
  counter: string;
  period: string;
  limit: number;
  used: number;
  updatedAt: TDate;
}
export interface QuotaReservationRow<TDate = string> {
  id: string;
  userId: string;
  counter: string;
  period: string;
  amount: number;
  limit: number;
  status: QuotaReservationStatus;
  resourceType: string;
  resourceId: string;
  expiresAt: TDate;
  createdAt: TDate;
  finishedAt: TDate | null;
  reason: string | null;
}
/** `changed: false` means the reservation was already in the requested (or a terminal) state. */
export interface QuotaReservationActionResult {
  id: string;
  changed: boolean;
}

// ─── Mail (§8.5) ─────────────────────────────────────────────────────────────

export interface MailLogRow<TDate = string> {
  id: string;
  userId: string | null;
  recipient: string;
  subject: string;
  template: string | null;
  provider: string | null;
  messageId: string | null;
  status: 'success' | 'failed';
  errorMessage: string | null;
  createdAt: TDate;
}
