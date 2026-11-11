import { resolveSubscriptionsSettings, type SubscriptionsSettings } from '@zucker-framework/back-office/subscriptions';

export { SubscriptionsService, SUBSCRIPTION_CHANGED_EVENT } from '@zucker-framework/back-office/subscriptions';

/** ENTITLEMENT_TIME_ZONE (default UTC) and ENTITLEMENT_RESERVATION_TTL_MS (default 15 minutes). */
export function subscriptionOptionsFromEnvironment(env: Readonly<NodeJS.ProcessEnv>): SubscriptionsSettings {
  const ttl = Number(env.ENTITLEMENT_RESERVATION_TTL_MS ?? 900000);
  if (!Number.isSafeInteger(ttl) || ttl < 1000 || ttl > 86400000) throw new Error('Invalid ENTITLEMENT_RESERVATION_TTL_MS');
  return resolveSubscriptionsSettings({ timeZone: env.ENTITLEMENT_TIME_ZONE?.trim() || 'UTC', reservationTtlMs: ttl });
}
