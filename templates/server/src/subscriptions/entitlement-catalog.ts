import type { EntitlementCatalog, EntitlementCounterDefinition, EntitlementFeatureDefinition } from '@zucker-framework/credit';

/**
 * PRODUCT-OWNED EXAMPLE. Replace these features, counters and labels with your application's own.
 * The catalog lives in code (not the database): plans only switch declared features on and set
 * declared counters' limits, and every plan write is validated against this list.
 *
 * - `metered` features consume their `counter` (a missing counter in a plan means no allowance).
 * - `benefit` features are plain switches (other missing counters are unlimited).
 */
export interface AppFeature extends EntitlementFeatureDefinition {
  label: string;
  description: string;
}
export interface AppCounter extends EntitlementCounterDefinition {
  label: string;
  unit: string;
}

export const APP_ENTITLEMENT_CATALOG = {
  features: [
    { key: 'projects', label: 'Projects', description: 'Create a project; work inside a counted project is free', category: 'metered', counter: 'projects_per_month' },
    { key: 'exports', label: 'Exports', description: 'Export a finished result', category: 'metered', counter: 'exports_per_day' },
    { key: 'prioritySupport', label: 'Priority support', description: 'Faster support responses', category: 'benefit' },
    { key: 'adFree', label: 'Ad-free', description: 'No advertising while the subscription is active', category: 'benefit' },
  ],
  counters: [
    { key: 'projects_per_month', label: 'Projects', unit: 'per month', period: 'month' },
    { key: 'exports_per_day', label: 'Exports', unit: 'per day', period: 'day' },
  ],
} as const satisfies EntitlementCatalog<AppFeature, AppCounter>;

export const ENTITLEMENT_SERVICE = Symbol('ENTITLEMENT_SERVICE');
