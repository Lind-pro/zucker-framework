import { randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { DATABASE_ADAPTER, type DatabaseAdapter } from '@zucker-framework/core';
import {
  EntitlementService, QuotaCapacityExceededError, QuotaReservationService, ResourceChargeError, ResourceChargeService,
  counterSnapshot, isActiveTerm, type CounterSnapshot, type ResourceCharge, type ResolvedEntitlements,
} from '@zucker-framework/credit';
import {
  PlanCatalogService, SubscriptionAssignmentService, localizedText, planCheckoutMode, planOfferId, toMinorUnits,
  type ResolvedPlanOffer, type SubscriptionChange, type UserSubscriptionRecord,
} from '@zucker-framework/payment';
import {
  mapPortError, type QuotaReservationAdminPort, type UserSubscriptionAdminPort, type UserSubscriptionAssignment,
  type UserSubscriptionListQuery,
} from '@zucker-framework/admin';
import {
  CYCLE_FOR_INTERVAL, type EntitlementCatalogResponse, type PublicBillingCheckoutPolicy, type PublicBillingCurrencies,
  type PublicPlan, type PublicPricingCatalog,
} from '@zucker-framework/fe-types/back-office';
import { createPlanFulfillmentHooks } from './payment-writeback';
import { createPlanCatalogStore, loadPlan, loadPlans, presentPlan, type StoredPlan } from './plan-catalog.store';
import {
  createQuotaReservationStore, createResourceChargeLookup, type CapturedQuotaInput, type StoredQuotaReservation,
} from './quota.store';
import type { SubscriptionsModels } from './storage';
import type { PresentedEntitlementCatalog, ResolvedSubscriptionsOptions, SubscriptionsSettingsResolver } from './subscriptions.options';
import type { SubscriptionsBillingPort } from './subscriptions.ports';
import { SUBSCRIPTIONS_BILLING, SUBSCRIPTIONS_EVENT_BUS, SUBSCRIPTIONS_OPTIONS, SUBSCRIPTIONS_SETTINGS } from './subscriptions.tokens';
import { createUserSubscriptionStore } from './user-subscription.store';

/** Untrusted `?currency=`: an ISO 4217 code or nothing (unknown values never filter to an empty page). */
function publicCurrency(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Z]{3}$/.test(value) ? value : undefined;
}
/** Untrusted `?locale=`: a locale tag or nothing. */
function publicLocale(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$/.test(value) ? value : undefined;
}
const NO_CHECKOUT: PublicBillingCheckoutPolicy = Object.freeze({ defaultProvider: null, allowProviderChoice: true, promoCodes: 'none' });
const USER_SUMMARY = { id: true, username: true, email: true } as const;

/** Minimal event bus (`EventEmitter2` from `@nestjs/event-emitter` satisfies it). */
export interface SubscriptionsEventBus { emitAsync(event: string, ...values: unknown[]): Promise<unknown> }

interface UserSummary { id: string; username: string; email: string | null }
interface SubscriptionView { row: UserSubscriptionRecord; user: UserSummary | null; plan: StoredPlan | null }

/**
 * Plans, user subscriptions, entitlements and metered quota over the product's tables. Also the
 * admin `UserSubscriptionAdminPort`; `plans` is the admin `PlanAdminPort`, `reservations` the
 * `QuotaReservationAdminPort`.
 */
@Injectable()
export class SubscriptionsService implements UserSubscriptionAdminPort {
  private readonly logger = new Logger('BackOfficeSubscriptions');
  private readonly entitlementServices = new Map<string, EntitlementService<PresentedEntitlementCatalog>>();
  readonly plans: PlanCatalogService;
  readonly assignments: SubscriptionAssignmentService<DatabaseAdapter>;
  /** Durable reservation transitions for administrator release/confirm. */
  readonly reservations: QuotaReservationAdminPort & QuotaReservationService<DatabaseAdapter, StoredQuotaReservation, CapturedQuotaInput>;
  private readonly charges: ResourceChargeService<DatabaseAdapter, StoredQuotaReservation, CapturedQuotaInput>;

  constructor(
    @Inject(DATABASE_ADAPTER) private readonly database: DatabaseAdapter,
    @Inject(SUBSCRIPTIONS_OPTIONS) private readonly options: ResolvedSubscriptionsOptions,
    @Inject(SUBSCRIPTIONS_SETTINGS) private readonly settings: SubscriptionsSettingsResolver,
    @Optional() @Inject(SUBSCRIPTIONS_BILLING) private readonly billing?: SubscriptionsBillingPort,
    @Optional() @Inject(SUBSCRIPTIONS_EVENT_BUS) private readonly events?: SubscriptionsEventBus,
  ) {
    const storage = options.storage;
    // Validates the catalog at startup.
    void this.entitlements;
    this.plans = new PlanCatalogService(createPlanCatalogStore(database, storage), { validateGrant: grant => this.entitlements.validateGrant(grant) });
    this.assignments = new SubscriptionAssignmentService(createUserSubscriptionStore(database, storage), {
      activeTerm: isActiveTerm,
      changed: change => this.publish(change),
      onNotifyError: error => this.logger.warn(`Subscription change event failed: ${error instanceof Error ? error.message : 'unknown'}`),
    });
    const quotaStore = createQuotaReservationStore(database, storage, { allowUnlimited: true });
    this.reservations = new QuotaReservationService(quotaStore);
    this.charges = new ResourceChargeService(quotaStore, createResourceChargeLookup(storage), {
      onReleaseError: (_error, id) => this.logger.warn(`Releasing reservation ${id} failed; it expires instead`),
      onConfirmError: (_error, id) => this.logger.error(`Confirming reservation ${id} failed after the work succeeded; the use is uncharged (raise reservationTtlMs above the work duration)`),
    });
    // Plans are the offers: checkout prices come from the plan catalog, and paid orders write back
    // through the frozen plan snapshot. Billing never imports this host.
    if (billing && options.features.paymentWriteBack) {
      billing.usePlanOffers({
        resolve: (offerId, providerId, ownerId) => this.resolvePlanOffer(offerId, providerId, ownerId),
        claims: async offerId => !!(await this.plans.findBySlug(offerId)),
      });
      billing.useFulfillmentHooks(createPlanFulfillmentHooks(database, storage));
    }
  }

  private get models(): SubscriptionsModels { return this.options.storage.of(this.database); }

  /**
   * A plan price for checkout, admitted for this buyer: a purchase whose payment would be recorded
   * without improving the buyer's term is refused with 409 and `details.refusal` before an order exists.
   */
  private async resolvePlanOffer(offerId: string, providerId: string, ownerId: string): Promise<ResolvedPlanOffer | null> {
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
  get entitlements(): EntitlementService<PresentedEntitlementCatalog> {
    const { timeZone } = this.settings();
    let service = this.entitlementServices.get(timeZone);
    if (!service) {
      service = new EntitlementService({ catalog: this.options.catalog, timeZone });
      this.entitlementServices.set(timeZone, service);
    }
    return service;
  }

  private async publish(change: SubscriptionChange): Promise<void> {
    await this.events?.emitAsync(this.options.changeEvent, change);
  }

  /** Public catalog: declared in code, labels and stable translation keys included. */
  catalog(): EntitlementCatalogResponse {
    const { catalog } = this.options;
    return {
      features: catalog.features.map(feature => ({ key: feature.key, label: feature.label ?? feature.key,
        labelKey: `entitlements.feature.${feature.key}`, description: feature.description ?? '', category: feature.category,
        ...(feature.counter !== undefined ? { counter: feature.counter } : {}) })),
      counters: catalog.counters.map(counter => ({ key: counter.key, label: counter.label ?? counter.key,
        labelKey: `entitlements.counter.${counter.key}`, unit: counter.unit ?? '', period: counter.period })),
    } as EntitlementCatalogResponse;
  }

  /**
   * Public plans: listed plans with every price (optionally one currency). A price is purchasable
   * when its amount is positive and an enabled provider can sell it; `offerId` is then the checkout
   * offer for exactly this plan price. `current` marks the plan of the viewer's active term.
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
        const providers = this.billing && toMinorUnits(price.amount, price.currency) > 0
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
      this.billing ? this.billing.catalog.publicPacks(publicCurrency(currency), publicLocale(locale)) : [],
      this.billing ? this.billing.checkoutPolicy() : NO_CHECKOUT,
    ]);
    return { plans, packs, checkout };
  }

  /** `GET /billing/currencies`: currencies of listed plan and pack prices, most common first suggested. */
  async currencies(): Promise<PublicBillingCurrencies> {
    const [plans, packs] = await Promise.all([this.plans.list({ listedOnly: true }), this.billing ? this.billing.catalog.publicPacks() : []]);
    const counts = new Map<string, number>();
    for (const price of [...plans.flatMap(plan => plan.prices), ...packs.flatMap(pack => pack.prices)])
      counts.set(price.currency, (counts.get(price.currency) ?? 0) + 1);
    const currencies = [...counts.keys()].sort();
    const suggested = [...counts.entries()].sort(([a, x], [b, y]) => y - x || a.localeCompare(b))[0]?.[0] ?? null;
    return { currencies, default: suggested };
  }

  private async subscriptionOf(userId: string): Promise<UserSubscriptionRecord | null> {
    return await this.models.subscriptions.findUnique({ where: { userId } }) as unknown as UserSubscriptionRecord | null;
  }

  /** Plan id of the user's active term, or null. */
  private async currentPlanId(userId: string): Promise<string | null> {
    const row = await this.subscriptionOf(userId);
    return row && isActiveTerm(row, new Date()) ? row.planId : null;
  }

  private async current(userId: string, now: Date) {
    const row = await this.subscriptionOf(userId);
    const stored = row ? await loadPlan(this.models, { id: row.planId }) : null;
    const plan = stored ? presentPlan(stored) : null;
    const resolved = this.entitlements.resolve(plan, row, now);
    return { row, plan, resolved };
  }

  /** Counter snapshots for every catalog counter in its current period (empty with `features.quota` off). */
  async quotas(userId: string, limits: ResolvedEntitlements['limits'], now = new Date()): Promise<Record<string, CounterSnapshot>> {
    if (!this.options.features.quota) return {};
    const keys = this.options.catalog.counters.map(counter => ({ counter: counter.key, period: this.entitlements.period(counter.key, now) }));
    if (!keys.length) return {};
    const models = this.models;
    const [usage, reserved] = await Promise.all([
      models.quotaUsage.findMany({ where: { subjectId: userId, OR: keys }, select: { counter: true, period: true, used: true } }) as unknown as Promise<Array<{ counter: string; period: string; used: number }>>,
      models.quotaReservations.findMany({ where: { subjectId: userId, status: 'RESERVED', expiresAt: { gt: now },
        counter: { in: keys.map(key => key.counter) } }, select: { counter: true, period: true, amount: true } }) as unknown as Promise<Array<{ counter: string; period: string; amount: number }>>,
    ]);
    return Object.fromEntries(keys.map(({ counter, period }) => [counter, counterSnapshot({
      limit: limits[counter] ?? 0, period,
      used: usage.find(row => row.counter === counter && row.period === period)?.used ?? 0,
      reserved: reserved.filter(row => row.counter === counter && row.period === period).reduce((sum, row) => sum + row.amount, 0),
    })]));
  }

  /** Current-user entitlements (`GET /billing/entitlements/me`). */
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
    options: { reservationId?: string; tx?: DatabaseAdapter } = {}): Promise<T> {
    if (!this.options.features.quota) throw new Error('[back-office/subscriptions] metered features are disabled (features.quota)');
    const feature = this.entitlements.feature(featureKey);
    if (feature.category !== 'metered' || !feature.counter) throw new Error(`Feature ${featureKey} is not metered`);
    const counter = feature.counter;
    const now = new Date();
    const { plan, resolved } = await this.current(userId, now);
    if (!plan || !resolved.features[featureKey]) throw new ForbiddenException('The current plan does not include this feature');
    try {
      return await this.charges.run({ id: options.reservationId ?? randomUUID(), subjectId: userId, counter,
        amount: 1, period: this.entitlements.period(counter, now), limit: resolved.limits[counter],
        policyVersion: `plan:${plan.id}@${plan.revision}`, resourceType: resource.type, resourceId: resource.id,
        expiresAt: new Date(now.getTime() + this.settings().reservationTtlMs) }, work, options.tx ? { tx: options.tx } : {});
    } catch (error) {
      if (error instanceof QuotaCapacityExceededError) throw new ConflictException('The plan quota for this feature is exhausted');
      if (error instanceof ResourceChargeError) mapPortError(error);
      throw error;
    }
  }

  // ─── Administration port ──────────────────────────────────────────────────
  private present(view: SubscriptionView, now = new Date()) {
    const { row, user, plan } = view;
    return { id: row.id, userId: row.userId, status: row.status, billingCycle: row.billingCycle, startDate: row.startDate,
      endDate: row.endDate, cancelAtPeriodEnd: row.cancelAtPeriodEnd, canceledAt: row.canceledAt, source: row.source,
      active: isActiveTerm(row, now), createdAt: row.createdAt, updatedAt: row.updatedAt,
      user: user ? { id: user.id, username: user.username, email: user.email } : null,
      plan: plan ? { id: plan.id, slug: plan.slug, name: plan.name } : null };
  }
  /** Same predicate as `isActiveTerm`, as a database filter (expiry is derived, never swept). */
  private activeWhere(now: Date) {
    return { status: { in: ['ACTIVE', 'CANCELED'] }, startDate: { lte: now },
      OR: [{ endDate: { gt: now } }, { endDate: null, billingCycle: 'LIFETIME', status: 'ACTIVE' }] };
  }
  /** Users and plans of subscription rows, read explicitly (no relation includes). */
  private async views(rows: UserSubscriptionRecord[]): Promise<SubscriptionView[]> {
    if (!rows.length) return [];
    const models = this.models;
    const [users, plans] = await Promise.all([
      models.users.findMany({ where: { id: { in: [...new Set(rows.map(row => row.userId))] } }, select: USER_SUMMARY }) as unknown as Promise<UserSummary[]>,
      loadPlans(models, rows.map(row => row.planId)),
    ]);
    return rows.map(row => ({ row, user: users.find(user => user.id === row.userId) ?? null, plan: plans.get(row.planId) ?? null }));
  }
  async list(query: UserSubscriptionListQuery) {
    const now = new Date();
    const models = this.models;
    let planId: string | undefined;
    if (query.planSlug) {
      const plan = await models.plans.findUnique({ where: { slug: query.planSlug }, select: { id: true } }) as { id: string } | null;
      if (!plan) return { data: [], total: 0, page: query.page, pageSize: query.pageSize };
      planId = plan.id;
    }
    // Every filter is a separate AND term: the activity predicate has its own `status`/`OR` keys.
    const where = { AND: [
      ...(query.userId ? [{ userId: query.userId }] : []), ...(query.status ? [{ status: query.status }] : []),
      ...(planId ? [{ planId }] : []),
      ...(query.activity === 'active' ? [this.activeWhere(now)] : query.activity === 'inactive' ? [{ NOT: this.activeWhere(now) }] : []),
    ] };
    const [rows, total] = await Promise.all([
      models.subscriptions.findMany({ where, orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize, take: query.pageSize }) as unknown as Promise<UserSubscriptionRecord[]>,
      models.subscriptions.count({ where }),
    ]);
    return { data: (await this.views(rows)).map(view => this.present(view, now)), total, page: query.page, pageSize: query.pageSize };
  }
  async detail(userId: string) {
    const row = await this.subscriptionOf(userId);
    if (!row) return null;
    const [view] = await this.views([row]);
    const now = new Date();
    const resolved = this.entitlements.resolve(view.plan ? presentPlan(view.plan) : null, row, now);
    return { ...this.present(view, now), features: resolved.features, quotas: await this.quotas(userId, resolved.limits, now) };
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
