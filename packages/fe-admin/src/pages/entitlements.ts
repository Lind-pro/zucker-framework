import { useMemo } from 'react';
import { useAdmin, useResource, type ResourceState } from '../app/context';
import { useAdminI18n } from '../i18n/context';
import type {
  EntitlementCatalogCounter,
  EntitlementCatalogFeature,
  EntitlementCatalogResponse,
} from '@zucker-framework/fe-types/back-office';

/** Product-declared entitlement catalog (`GET /billing/entitlements/catalog`, RFC §8.1). */
export type EntitlementFeature = EntitlementCatalogFeature;
export type EntitlementCounter = EntitlementCatalogCounter;
export type EntitlementCatalog = EntitlementCatalogResponse;

export function parseEntitlementCatalog(value: unknown): EntitlementCatalog {
  const catalog = value as Partial<EntitlementCatalog> | null;
  if (!catalog || !Array.isArray(catalog.features) || !Array.isArray(catalog.counters))
    throw new Error('Unexpected entitlement catalog');
  const features = catalog.features.filter(
    (feature): feature is EntitlementFeature => !!feature && typeof feature.key === 'string' && !!feature.key,
  );
  const counters = catalog.counters.filter(
    (counter): counter is EntitlementCounter => !!counter && typeof counter.key === 'string' && !!counter.key,
  );
  return {
    features: features.map((feature) => ({ ...feature, label: feature.label || feature.key })),
    counters: counters.map((counter) => ({ ...counter, label: counter.label || counter.key })),
  };
}

/**
 * Catalog labels, descriptions and units in the active locale (`serverLabels` config). The stable
 * `labelKey` (`entitlements.feature.<key>`, `entitlements.counter.<key>`) is preferred over the text.
 */
export function localizeEntitlementCatalog(
  catalog: EntitlementCatalog,
  serverLabel: (text: string, labelKey?: string | null) => string,
): EntitlementCatalog {
  const optional = (text: string | undefined, key: string) => (text ? serverLabel(text, key) : text);
  return {
    features: catalog.features.map((feature) => {
      const key = feature.labelKey ?? `entitlements.feature.${feature.key}`;
      return { ...feature, label: serverLabel(feature.label, key), description: optional(feature.description, `${key}.description`) };
    }),
    counters: catalog.counters.map((counter) => {
      const key = counter.labelKey ?? `entitlements.counter.${counter.key}`;
      return { ...counter, label: serverLabel(counter.label, key), unit: optional(counter.unit, `${key}.unit`) };
    }),
  };
}

export function useEntitlementCatalog(): ResourceState<EntitlementCatalog> {
  const { session, config } = useAdmin();
  const { serverLabel } = useAdminI18n();
  const resource = useResource(
    async (signal) => parseEntitlementCatalog(await session.api.get(config.endpoints.entitlementCatalog, undefined, { signal })),
    [],
  );
  const data = useMemo(() => resource.data && localizeEntitlementCatalog(resource.data, serverLabel), [resource.data, serverLabel]);
  return { ...resource, data };
}

/** Label for a counter key from the catalog, falling back to the raw key. */
export function counterLabel(catalog: EntitlementCatalog | undefined, key: string): string {
  return catalog?.counters.find((counter) => counter.key === key)?.label ?? key;
}
