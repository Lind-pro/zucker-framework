import { backOfficeToken } from '../shared/tokens';

/** Resolved {@link BackOfficeSubscriptionsOptions} (frozen). */
export const SUBSCRIPTIONS_OPTIONS = backOfficeToken('subscriptions', 'options');
/** `() => SubscriptionsSettings`, read on every use so a runtime configuration source can change it. */
export const SUBSCRIPTIONS_SETTINGS = backOfficeToken('subscriptions', 'settings');
/** Optional {@link SubscriptionsBillingPort}: checkout providers, credit packs, plan offers and write-back registration. */
export const SUBSCRIPTIONS_BILLING = backOfficeToken('subscriptions', 'billing');
/** Optional {@link SubscriptionsViewer}: identity of an optional bearer on the public pricing route. */
export const SUBSCRIPTIONS_VIEWER = backOfficeToken('subscriptions', 'viewer');
/** The `PlanCatalogService` (admin `PlanAdminPort`). */
export const SUBSCRIPTIONS_PLAN_CATALOG = backOfficeToken('subscriptions', 'planCatalog');
/** The `QuotaReservationService` used by the quota administration routes. */
export const SUBSCRIPTIONS_QUOTA_RESERVATIONS = backOfficeToken('subscriptions', 'quotaReservations');
/** `EventEmitter2` when `@nestjs/event-emitter` is installed and registered, else undefined (resolved lazily). */
export const SUBSCRIPTIONS_EVENT_BUS = backOfficeToken('subscriptions', 'eventBus');
