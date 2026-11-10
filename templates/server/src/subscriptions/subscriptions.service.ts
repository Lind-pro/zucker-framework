import { randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DATABASE_ADAPTER } from '@zucker-framework/core';
import {
  EntitlementService, QuotaCapacityExceededError, QuotaReservationService, ResourceChargeError, ResourceChargeService,
  counterSnapshot, isActiveTerm, type CounterSnapshot, type ResourceCharge, type ResolvedEntitlements,
} from '@zucker-framework/credit';
import {
  PlanCatalogService, SubscriptionAssignmentService, localizedText, planCheckoutMode, planOfferId, toMinorUnits,
  type SubscriptionChange, type UserSubscriptionRecord,
} from '@zucker-framework/payment';
import {
  mapPortError, type QuotaReservationAdminPort, type UserSubscriptionAdminPort, type UserSubscriptionAssignment,
  type UserSubscriptionListQuery,
} from '@zucker-framework/admin';
import {
  CYCLE_FOR_INTERVAL, type EntitlementCatalogResponse, type PublicBillingCurrencies, type PublicPlan, type PublicPricingCatalog,
} from '@zucker-framework/fe-types/back-office';
import { ApplicationDatabase, type ApplicationTransaction } from '../database';
import type { CapturedQuotaInput, StoredQuotaReservation } from '../credits/quota.store';
import { BillingService } from '../billing/billing.service';
import { APP_ENTITLEMENT_CATALOG } from './entitlement-catalog';
import { PLAN_INCLUDE, createPlanCatalogStore, presentPlan, type StoredPlan } from './plan-catalog.store';
import { createUserSubscriptionStore } from './user-subscription.store';
import { createPlanQuotaStore, resourceChargeLookup } from './entitlement-quota';
import { planFulfillmentHooks } from './payment-writeback';

export const SUBSCRIPTION_OPTIONS = Symbol('SUBSCRIPTION_OPTIONS');
/** Untrusted `?currency=`: an ISO 4217 code or nothing (unknown values never filter to an empty page). */
function publicCurrency(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Z]{3}$/.test(value) ? value : undefined;
}
/** Untrusted `?locale=`: a locale tag or nothing. */
function publicLocale(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$/.test(value) ? value : undefined;
}
/** Emitted (in-process, after commit) for administrator assignments and cancellations. */
export const SUBSCRIPTION_CHANGED_EVENT = 'subscriptions.changed';
export interface SubscriptionOptions { timeZone: string; reservationTtlMs: number }
/** Read on every use, so a runtime configuration source can change it without a restart. */
export type SubscriptionOptionsResolver = () => SubscriptionOptions;
export function subscriptionOptionsFromEnvironment(env: Readonly<NodeJS.ProcessEnv>): SubscriptionOptions {
  const ttl = Number(env.ENTITLEMENT_RESERVATION_TTL_MS ?? 900000);
  if (!Number.isSafeInteger(ttl) || ttl < 1000 || ttl > 86400000) throw new Error('Invalid ENTITLEMENT_RESERVATION_TTL_MS');
  return { timeZone: env.ENTITLEMENT_TIME_ZONE?.trim() || 'UTC', reservationTtlMs: ttl };
}

interface SubscriptionRow extends UserSubscriptionRecord {
  user?: { id: string; username: string; email: string | null };
  plan?: StoredPlan;
}

/** Composition of the shared plan/subscription/entitlement mechanisms with this application's data. */
@Injectable()
export class SubscriptionsService implements UserSubscriptionAdminPort {
  private readonly logger = new Logger(SubscriptionsService.name);
  private readonly entitlementServices = new Map<string, EntitlementService<typeof APP_ENTITLEMENT_CATALOG>>();
  readonly plans: PlanCatalogService;
  readonly assignments: SubscriptionAssignmentService<ApplicationTransaction>;
  /** Durable reservation transitions for administrator release/confirm (RFC 8.4). */
  readonly reservations: QuotaReservationAdminPort;
  private readonly charges: ResourceChargeService<ApplicationTransaction, StoredQuotaReservation, CapturedQuotaInput>;

  constructor(
    @Inject(DATABASE_ADAPTER) private readonly database: ApplicationDatabase,
    @Inject(SUBSCRIPTION_OPTIONS) private readonly options: SubscriptionOptionsResolver,
    private readonly billing: BillingService,
    @Optional() private readonly events?: EventEmitter2,
  ) {
    this.plans = new PlanCatalogService(createPlanCatalogStore(database), { validateGrant: grant => this.entitlements.validateGrant(grant) });
    this.assignments = new SubscriptionAssignmentService(createUserSubscriptionStore(database), {
      activeTerm: isActiveTerm,
      changed: change => this.publish(change),
      onNotifyError: error => this.logger.warn(`Subscription change event failed: ${error instanceof Error ? error.message : 'unknown'}`),
    });
    this.reservations = new QuotaReservationService(createPlanQuotaStore(database));
    this.charges = new ResourceChargeService(createPlanQuotaStore(database), resourceChargeLookup, {
      onReleaseError: (_error, id) => this.logger.warn(`Releasing reservation ${id} failed; it expires instead`),
      onConfirmError: (_error, id) => this.logger.error(`Confirming reservation ${id} failed after the work succeeded; the use is uncharged (raise ENTITLEMENT_RESERVATION_TTL_MS above the work duration)`),
    });
    // Plans are the offers: checkout prices come from subscription_plans, and paid orders write back
    // through the frozen plan snapshot. Billing never imports this module.
    billing.usePlanOffers({
      resolve: (offerId, providerId, ownerId) => this.resolvePlanOffer(offerId, providerId, ownerId),
      claims: async offerId => !!(await this.plans.findBySlug(offerId)),
    });
    billing.useFulfillmentHooks(planFulfillmentHooks(database));
  }

  /**
   * A plan price for checkout, admitted for this buyer: a purchase whose payment would be recorded
   * without improving the buyer's term (active lifetime, a longer administrator grant of another
   * plan, a same-plan term that already covers the first recurring period, or a provider plan
   * subscription still billing) is refused with 409 and `details.refusal` before an order exists.
   */
  private async resolvePlanOffer(offerId: string, providerId: string, ownerId: string) {
    const resolved = await this.plans.resolveOffer(offerId, providerId);
    if (!resolved) return null;
    const { snapshot } = resolved;
    try {
      await this.assignments.admitPurchase(ownerId, { planId: snapshot.planId, billingCycle: CYCLE_FOR_INTERVAL[snapshot.interval],
        termDays: snapshot.termDays });
    } catch (error) {
      mapPortError(error);
    }
    return resolved;
  }

  /** Validated catalog in the configured time zone (rebuilt only when the zone changes). */
  get entitlements(): EntitlementService<typeof APP_ENTITLEMENT_CATALOG> {
    const { timeZone } = this.options();
    let service = this.entitlementServices.get(timeZone);
    if (!service) {
      service = new EntitlementService({ catalog: APP_ENTITLEMENT_CATALOG, timeZone });
      this.entitlementServices.set(timeZone, service);
    }
    return service;
  }

  private async publish(change: SubscriptionChange): Promise<void> {
    await this.events?.emitAsync(SUBSCRIPTION_CHANGED_EVENT, change);
  }

  /** RFC 8.1 public catalog: declared in code, labels and stable translation keys included. */
  catalog(): EntitlementCatalogResponse {
    return {
      features: APP_ENTITLEMENT_CATALOG.features.map(feature => ({ key: feature.key, label: feature.label,
        labelKey: `entitlements.feature.${feature.key}`, description: feature.description, category: feature.category,
        ...('counter' in feature ? { counter: feature.counter } : {}) })),
      counters: APP_ENTITLEMENT_CATALOG.counters.map(counter => ({ key: counter.key, label: counter.label,
        labelKey: `entitlements.counter.${counter.key}`, unit: counter.unit, period: counter.period })),
    };
  }

  /**
   * RFC 8.2 public plans: listed plans with every price (optionally one currency). A price is
   * purchasable when its amount is positive and an enabled provider can sell it; `offerId` is then
   * the checkout offer for exactly this plan price. `current` marks the plan of the caller's active
   * term (`viewerId` from an optional bearer; always false for guests).
   */
  async publicPlans(currency?: string, locale?: string, viewerId?: string | null): Promise<PublicPlan[]> {
    const wanted = publicCurrency(currency);
    const language = publicLocale(locale);
    const currentPlanId = viewerId ? await this.currentPlanId(viewerId) : null;
    return (await this.plans.list({ listedOnly: true })).map(plan => ({
      id: plan.id, slug: plan.slug, name: localizedText(plan.name, plan.nameI18n, language),
      description: localizedText(plan.description, plan.descriptionI18n, language), order: plan.order,
      features: plan.features, quotas: plan.quotas,
      featured: plan.featured === true, badge: localizedText(plan.badge ?? null, plan.badgeI18n, language),
      highlights: (language && plan.highlightsI18n?.[language]) || (language && plan.highlightsI18n?.[language.split('-')[0]]) || plan.highlights || [],
      current: currentPlanId === plan.id,
      prices: plan.prices.filter(price => !wanted || price.currency === wanted).map(price => {
        const providers = toMinorUnits(price.amount, price.currency) > 0
          ? this.billing.catalog.planProviders(planCheckoutMode(price.interval), price.providerRefs) : [];
        return { interval: price.interval, currency: price.currency, amount: price.amount, termDays: price.termDays,
          purchasable: providers.length > 0, offerId: providers.length ? planOfferId(plan.id, price.interval, price.currency) : null, providers,
          credits: price.credits ?? 0, creditExpiry: price.credits ? price.creditExpiry ?? null : null };
      }),
    }));
  }

  /** `GET /billing/plans`: listed plans, credit packs and the checkout provider policy. */
  async pricing(currency?: string, locale?: string, viewerId?: string | null): Promise<PublicPricingCatalog> {
    const [plans, packs, checkout] = await Promise.all([
      this.publicPlans(currency, locale, viewerId),
      this.billing.catalog.publicPacks(publicCurrency(currency), publicLocale(locale)),
      this.billing.checkoutPolicy(),
    ]);
    return { plans, packs, checkout };
  }

  /** `GET /billing/currencies`: currencies of listed plan and pack prices, most common first suggested. */
  async currencies(): Promise<PublicBillingCurrencies> {
    const [plans, packs] = await Promise.all([this.plans.list({ listedOnly: true }), this.billing.catalog.publicPacks()]);
    const counts = new Map<string, number>();
    for (const price of [...plans.flatMap(plan => plan.prices), ...packs.flatMap(pack => pack.prices)])
      counts.set(price.currency, (counts.get(price.currency) ?? 0) + 1);
    const currencies = [...counts.keys()].sort();
    const suggested = [...counts.entries()].sort(([a, x], [b, y]) => y - x || a.localeCompare(b))[0]?.[0] ?? null;
    return { currencies, default: suggested };
  }

  /** Plan id of the user's active term, or null. */
  private async currentPlanId(userId: string): Promise<string | null> {
    const row = await this.database.model('userSubscriptions').findUnique({ where: { userId } }) as UserSubscriptionRecord | null;
    return row && isActiveTerm(row, new Date()) ? row.planId : null;
  }

  private async current(userId: string, now: Date) {
    const row = await this.database.model('userSubscriptions').findUnique({ where: { userId }, include: { plan: true } }) as SubscriptionRow | null;
    const plan = row?.plan ? presentPlan(row.plan) : null;
    const resolved = this.entitlements.resolve(plan, row, now);
    return { row, plan, resolved };
  }

  /** Counter snapshots for every catalog counter in its current period. */
  async quotas(userId: string, limits: ResolvedEntitlements['limits'], now = new Date()): Promise<Record<string, CounterSnapshot>> {
    const keys = APP_ENTITLEMENT_CATALOG.counters.map(counter => ({ counter: counter.key, period: this.entitlements.period(counter.key, now) }));
    const [usage, reserved] = await Promise.all([
      this.database.model('quotaUsage').findMany({ where: { subjectId: userId, OR: keys } }) as Promise<Array<{ counter: string; period: string; used: number }>>,
      this.database.model('quotaReservation').findMany({ where: { subjectId: userId, status: 'RESERVED', expiresAt: { gt: now },
        counter: { in: keys.map(key => key.counter) } }, select: { counter: true, period: true, amount: true } }) as Promise<Array<{ counter: string; period: string; amount: number }>>,
    ]);
    return Object.fromEntries(keys.map(({ counter, period }) => [counter, counterSnapshot({
      limit: limits[counter] ?? 0, period,
      used: usage.find(row => row.counter === counter && row.period === period)?.used ?? 0,
      reserved: reserved.filter(row => row.counter === counter && row.period === period).reduce((sum, row) => sum + row.amount, 0),
    })]));
  }

  /** RFC 8.1 current-user entitlements. */
  async me(userId: string) {
    const now = new Date();
    const { row, plan, resolved } = await this.current(userId, now);
    return {
      active: resolved.active,
      plan: plan ? { id: plan.id, slug: plan.slug, name: plan.name } : null,
      status: row?.status ?? null,
      validUntil: resolved.active ? row?.endDate?.toISOString() ?? null : null,
      features: resolved.features,
      quotas: await this.quotas(userId, resolved.limits, now),
    };
  }

  /**
   * Charges a metered feature once per resource and counter (for example once per project): the
   * first successful `work` confirms, a failure releases, and later work inside an already charged
   * resource is free. While another request holds the resource's live reservation this rejects with
   * 409 (`in_progress`); retry after it settles. Pass `tx` to join a caller transaction.
   */
  async chargeResource<T>(userId: string, featureKey: string, resource: { type: string; id: string },
    work: (charge: ResourceCharge<StoredQuotaReservation>) => Promise<T>,
    options: { reservationId?: string; tx?: ApplicationTransaction } = {}): Promise<T> {
    const feature = this.entitlements.feature(featureKey);
    if (feature.category !== 'metered') throw new Error(`Feature ${featureKey} is not metered`);
    const now = new Date();
    const { plan, resolved } = await this.current(userId, now);
    if (!plan || !resolved.features[featureKey]) throw new ForbiddenException('The current plan does not include this feature');
    try {
      return await this.charges.run({ id: options.reservationId ?? randomUUID(), subjectId: userId, counter: feature.counter,
        amount: 1, period: this.entitlements.period(feature.counter, now), limit: resolved.limits[feature.counter],
        policyVersion: `plan:${plan.id}@${plan.revision}`, resourceType: resource.type, resourceId: resource.id,
        expiresAt: new Date(now.getTime() + this.options().reservationTtlMs) }, work, options.tx ? { tx: options.tx } : {});
    } catch (error) {
      if (error instanceof QuotaCapacityExceededError) throw new ConflictException('The plan quota for this feature is exhausted');
      if (error instanceof ResourceChargeError) mapPortError(error);
      throw error;
    }
  }

  // ─── RFC 8.3 administration port ──────────────────────────────────────────
  private present(row: SubscriptionRow, now = new Date()) {
    return { id: row.id, userId: row.userId, status: row.status, billingCycle: row.billingCycle, startDate: row.startDate,
      endDate: row.endDate, cancelAtPeriodEnd: row.cancelAtPeriodEnd, canceledAt: row.canceledAt, source: row.source,
      active: isActiveTerm(row, now), createdAt: row.createdAt, updatedAt: row.updatedAt,
      user: row.user ? { id: row.user.id, username: row.user.username, email: row.user.email } : null,
      plan: row.plan ? { id: row.plan.id, slug: row.plan.slug, name: row.plan.name } : null };
  }
  /** Same predicate as `isActiveTerm`, as a database filter (expiry is derived, never swept). */
  private activeWhere(now: Date) {
    return { status: { in: ['ACTIVE', 'CANCELED'] }, startDate: { lte: now },
      OR: [{ endDate: { gt: now } }, { endDate: null, billingCycle: 'LIFETIME', status: 'ACTIVE' }] };
  }
  async list(query: UserSubscriptionListQuery) {
    const now = new Date();
    // Every filter is a separate AND term: the activity predicate has its own `status`/`OR` keys
    // and must not replace the status filter.
    const where = { AND: [
      ...(query.userId ? [{ userId: query.userId }] : []), ...(query.status ? [{ status: query.status }] : []),
      ...(query.planSlug ? [{ plan: { slug: query.planSlug } }] : []),
      ...(query.activity === 'active' ? [this.activeWhere(now)] : query.activity === 'inactive' ? [{ NOT: this.activeWhere(now) }] : []),
    ] };
    const model = this.database.model('userSubscriptions');
    const [rows, total] = await Promise.all([
      model.findMany({ where, include: { user: { select: { id: true, username: true, email: true } }, plan: true },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }], skip: (query.page - 1) * query.pageSize, take: query.pageSize }) as Promise<SubscriptionRow[]>,
      model.count({ where }),
    ]);
    return { data: rows.map(row => this.present(row, now)), total, page: query.page, pageSize: query.pageSize };
  }
  async detail(userId: string) {
    const row = await this.database.model('userSubscriptions').findUnique({ where: { userId },
      include: { user: { select: { id: true, username: true, email: true } }, plan: { include: PLAN_INCLUDE } } }) as SubscriptionRow | null;
    if (!row) return null;
    const now = new Date();
    const resolved = this.entitlements.resolve(row.plan ? presentPlan(row.plan) : null, row, now);
    return { ...this.present(row, now), features: resolved.features, quotas: await this.quotas(userId, resolved.limits, now) };
  }
  async assign(userId: string, input: UserSubscriptionAssignment, actorId: string | undefined) {
    await this.assignments.assign(userId, input, actorId);
    return this.detail(userId);
  }
  async cancel(userId: string, actorId: string | undefined) {
    await this.assignments.cancel(userId, actorId);
    return this.detail(userId);
  }
}
