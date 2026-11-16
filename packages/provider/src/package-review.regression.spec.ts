import { afterEach, describe, expect, it, vi } from 'vitest';
import { DefaultProviderRegistry } from './provider-registry';
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('Package review regressions', () => {
  it('R06: disposing an old registration preserves its replacement', () => {
    const registry = new DefaultProviderRegistry();
    const oldHandle = registry.register({ id: 'provider', instance: 'old' });
    const fresh = { id: 'provider', instance: 'new' };
    registry.register(fresh);
    expect(registry.get('provider')).toBe(fresh);
    oldHandle.dispose();
    expect(registry.get('provider')).toBe(fresh);
  });


  it('a handle owns its registration even when the same provider object is registered again', () => {
    const registry = new DefaultProviderRegistry();
    const provider = { id: 'p', instance: 1 };
    const stale = registry.register(provider);
    const current = registry.register(provider);
    const removed = vi.fn();
    registry.addHook({ onUnregister: removed });
    stale.dispose();
    expect(registry.get('p')).toBe(provider);
    provider.id = 'mutated';
    current.dispose();
    current.dispose();
    expect(registry.get('p')).toBeUndefined();
    expect(removed).toHaveBeenCalledOnce();
  });

});
