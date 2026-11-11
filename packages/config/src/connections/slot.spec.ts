import { describe, expect, it, vi } from 'vitest';
import { ConnectionSettingsError } from './errors';
import { localizeConnectionDescriptor } from './registry';
import { RuntimeProviderSlot, SLOT_BUILD_FAILED, type RuntimeProviderFreshness, type RuntimeProviderSlotSource } from './slot';

/** In-memory source: `revision` is what the store holds now; `seen` records the freshness asked for. */
function source(initial = 1) {
  const state = { revision: initial, seen: [] as RuntimeProviderFreshness[], loads: 0 };
  const src: RuntimeProviderSlotSource = {
    async providerState(ids, freshness) {
      state.seen.push(freshness);
      const revisions = new Map(ids.map(id => [id, state.revision]));
      return { revisions, load: async () => { state.loads += 1; return { environment: Object.freeze({ KEY: `v${state.revision}` }), revisions: new Map(ids.map(id => [id, state.revision])) }; } };
    },
  };
  return { state, src };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

describe('RuntimeProviderSlot', () => {
  it('builds once for concurrent callers and reuses the instance while revisions are unchanged', async () => {
    const { src } = source();
    const build = vi.fn(async (env: Readonly<NodeJS.ProcessEnv>) => { await tick(); return { key: env.KEY }; });
    const slot = new RuntimeProviderSlot(src, { profiles: ['p'], build, freshness: 'strict' });
    const results = await Promise.all(Array.from({ length: 10 }, () => slot.get()));
    expect(build).toHaveBeenCalledTimes(1);
    expect(new Set(results).size).toBe(1);
    expect(await slot.get()).toBe(results[0]);
    expect(slot.state().revisions?.get('p')).toBe(1);
  });

  it('swaps on a new revision and disposes the old instance only after in-flight users release it', async () => {
    const { state, src } = source();
    const events: string[] = [];
    const slot = new RuntimeProviderSlot(src, { profiles: ['p'], freshness: 'strict',
      build: env => ({ key: env.KEY }), dispose: instance => { events.push(`dispose ${instance.key}`); } });
    let release!: () => void;
    const inFlight = slot.use(async instance => { events.push(`start ${instance.key}`); await new Promise<void>(resolve => { release = resolve; }); events.push(`end ${instance.key}`); });
    await tick();
    state.revision = 2;
    expect((await slot.get()).key).toBe('v2');
    await tick();
    expect(events).toEqual(['start v1']);
    release(); await inFlight; await tick();
    expect(events).toEqual(['start v1', 'end v1', 'dispose v1']);
  });

  it('keeps serving the previous instance when a rebuild fails and reports the failure once', async () => {
    const { state, src } = source();
    const onBuildError = vi.fn();
    const build = vi.fn((env: Readonly<NodeJS.ProcessEnv>) => { if (env.KEY === 'v2') throw new Error('synthetic secret-bearing message'); return { key: env.KEY }; });
    const slot = new RuntimeProviderSlot(src, { profiles: ['p'], build, freshness: 'strict', onBuildError });
    const first = await slot.get();
    state.revision = 2;
    expect(await slot.get()).toBe(first);
    expect(await slot.get()).toBe(first);
    expect(build).toHaveBeenCalledTimes(2);
    expect(onBuildError).toHaveBeenCalledTimes(1);
    expect(slot.state().failedRevisions?.get('p')).toBe(2);
    state.revision = 3;
    expect((await slot.get()).key).toBe('v3');
    expect(slot.state().failedRevisions).toBeUndefined();
  });

  it('fails with a generic 503 when there is no previous instance to fall back to', async () => {
    const { src } = source();
    const slot = new RuntimeProviderSlot(src, { profiles: ['p'], freshness: 'ttl', build: () => { throw new Error('SYNTHETIC-SECRET'); } });
    const error = await slot.get().catch(caught => caught);
    expect(error).toBeInstanceOf(ConnectionSettingsError);
    expect(error).toMatchObject({ status: 503, message: SLOT_BUILD_FAILED });
    expect(String(error.message)).not.toContain('SYNTHETIC-SECRET');
  });

  it('passes its freshness to the source on every call', async () => {
    for (const freshness of ['ttl', 'strict'] as const) {
      const { state, src } = source();
      const slot = new RuntimeProviderSlot(src, { profiles: ['p'], build: env => env.KEY, freshness });
      await slot.get(); await slot.get();
      expect(state.seen).toEqual([freshness, freshness]);
    }
  });

  it('rejects malformed options and refuses use after close', async () => {
    const { src } = source();
    expect(() => new RuntimeProviderSlot(src, { profiles: [], build: () => 1, freshness: 'ttl' })).toThrow();
    expect(() => new RuntimeProviderSlot(src, { profiles: ['a', 'a'], build: () => 1, freshness: 'ttl' })).toThrow();
    expect(() => new RuntimeProviderSlot(src, { profiles: ['a'], build: () => 1, freshness: 'eventual' as never })).toThrow();
    const dispose = vi.fn();
    const slot = new RuntimeProviderSlot(src, { profiles: ['p'], build: () => ({}), dispose, freshness: 'ttl' });
    await slot.get(); await slot.close();
    expect(dispose).toHaveBeenCalledTimes(1);
    await expect(slot.get()).rejects.toThrow('closed');
  });
});

describe('localizeConnectionDescriptor', () => {
  const descriptor = { profile: { id: 'payment-x', name: 'X', category: 'Payments', labelKey: 'connections.payment-x', fields: [
    { key: 'X_ENABLED', label: 'Enabled', labelKey: 'connections.field.X_ENABLED', type: 'boolean' as const, defaultValue: 'false' },
    { key: 'X_SECRET', label: 'Secret', labelKey: 'connections.field.X_SECRET', type: 'secret' as const, description: 'English' },
  ] } };
  it('replaces display text only and keeps keys, types and defaults', () => {
    expect(localizeConnectionDescriptor(descriptor, { name: '甲', category: '支付', fields: { X_SECRET: { label: '密钥', description: '说明' } } })).toEqual({
      id: 'payment-x', name: '甲', category: '支付', fields: [
        { key: 'X_ENABLED', label: 'Enabled', type: 'boolean', defaultValue: 'false' },
        { key: 'X_SECRET', label: '密钥', type: 'secret', description: '说明' },
      ] });
  });
  it('refuses labels for keys the descriptor does not declare', () => {
    expect(() => localizeConnectionDescriptor(descriptor, { fields: { X_RENAMED: { label: 'x' } } })).toThrow(/no field X_RENAMED/);
  });
});
