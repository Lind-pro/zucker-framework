import 'server-only';
import { cache } from 'react';
import { parseEntitlementCatalog, parsePricingCatalog, type EntitlementCatalog, type PricingCatalog } from './pricing';

/**
 * Anonymous pricing reads for server-rendered (shared-cacheable) HTML. No Authorization header is
 * ever sent, so `current` is always false here; signed-in visitors get their current plan from a
 * browser-side read. Plans and provider availability change from the admin without a revalidate
 * notification, so the data cache keeps them only briefly.
 */
export const PRICING_REVALIDATE_SECONDS = 300;
export const PRICING_TAGS = ['billing', 'billing:plans'];

async function readApi(path: string, query: Record<string, string>, tags: string[]): Promise<unknown> {
  const base = (process.env.API_URL ?? 'http://localhost:4200/api').replace(/\/+$/, '');
  const url = new URL(`${base}${path}`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  const response = await fetch(url, {
    next: { revalidate: PRICING_REVALIDATE_SECONDS, tags },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`Pricing read failed with HTTP ${response.status}`);
  const body: unknown = await response.json();
  return body && typeof body === 'object' && 'result' in body ? body.result : body;
}

/** `null` when the API is unavailable: the pricing UI then loads the catalog in the browser. */
export const readPricingCatalog = cache(async (locale: string): Promise<PricingCatalog | null> => {
  try {
    return parsePricingCatalog(await readApi('/billing/plans', { locale }, PRICING_TAGS));
  } catch {
    return null;
  }
});

export const readEntitlementCatalog = cache(async (): Promise<EntitlementCatalog | null> => {
  try {
    return parseEntitlementCatalog(await readApi('/billing/entitlements/catalog', {}, PRICING_TAGS));
  } catch {
    return null;
  }
});
