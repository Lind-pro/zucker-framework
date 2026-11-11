/**
 * Resolver/array parity: the whole `service.spec.ts` suite runs again with every adapter list
 * replaced by an asynchronous, hand-written `HostedCheckoutProviderResolver` (not the built-in static
 * one), so both ways of supplying providers keep identical behaviour.
 */
import type { HostedCheckoutAdapter, HostedCheckoutOptions, HostedCheckoutProviderResolver } from './types';
import type * as ServiceModule from './service';

vi.mock('./service', async (importOriginal) => {
  const actual = await importOriginal<typeof ServiceModule>();
  const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
  function resolver(adapters: readonly HostedCheckoutAdapter[]): HostedCheckoutProviderResolver {
    // Same validation as the array form, so construction-time refusals stay identical.
    actual.staticHostedCheckoutProviders(adapters);
    const find = (id: string) => adapters.find(adapter => adapter.id === id);
    return {
      ids: async () => { await tick(); return adapters.map(adapter => adapter.id); },
      current: async id => { await tick(); const adapter = find(id); return adapter ? { adapter } : undefined; },
      forOrder: async order => { await tick(); return find(order.providerId); },
      webhookCandidates: async id => { await tick(); const adapter = find(id); return adapter ? [adapter] : []; },
    };
  }
  class ResolverBackedService extends actual.HostedCheckoutService {
    constructor(options: HostedCheckoutOptions) {
      super({ ...options, providers: Array.isArray(options.providers) ? resolver(options.providers) : options.providers });
    }
  }
  return { ...actual, HostedCheckoutService: ResolverBackedService };
});

import './service.spec';
