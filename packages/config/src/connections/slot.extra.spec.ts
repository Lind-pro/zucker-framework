import { describe, expect, it, vi } from 'vitest';
import { RuntimeProviderSlot, type RuntimeProviderFreshness, type RuntimeProviderSlotSource } from './slot';

const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
/** Source whose revision per call and load latency are scripted by the test. */
function scripted() {
  const state = { revision: 1, loadDelay: (_revision: number) => 0 };
  const src: RuntimeProviderSlotSource = {
    async providerState(ids, _freshness: RuntimeProviderFreshness) {
      const seen = state.revision, revisions = new Map(ids.map(id => [id, seen]));
      return { revisions, load: async () => { await tick(state.loadDelay(seen)); return { environment: Object.freeze({ KEY: `v${seen}` }), revisions: new Map(revisions) }; } };
    },
  };
  return { state, src };
}

describe('RuntimeProviderSlot (additional)', () => {
  it('disposes a replaced instance exactly once, only after the last of several leases ends', async () => {
    const { state, src } = scripted(), events: string[] = [];
    const slot = new RuntimeProviderSlot(src, { profiles: ['p'], freshness: 'strict', build: env => ({ key: env.KEY }), dispose: i => { events.push(`dispose ${i.key}`); } });
    const releases: Array<() => void> = [];
    const users = [1, 2, 3].map(n => slot.use(async i => { events.push(`start ${n} ${i.key}`); await new Promise<void>(resolve => releases.push(resolve)); events.push(`end ${n}`); }));
    await tick(5);
    state.revision = 2;
    expect((await slot.get()).key).toBe('v2'); await tick();
    expect(events.filter(e => e.startsWith('dispose'))).toEqual([]);
    // Release out of order: first the middle, then the last, then the first.
    releases[1](); await users[1]; await tick(); expect(events).not.toContain('dispose v1');
    releases[2](); await users[2]; await tick(); expect(events).not.toContain('dispose v1');
    releases[0](); await users[0]; await tick();
    expect(events.filter(e => e.startsWith('dispose'))).toEqual(['dispose v1']);
    expect(events.indexOf('dispose v1')).toBeGreaterThan(events.indexOf('end 1'));
    expect(events.indexOf('dispose v1')).toBeGreaterThan(events.indexOf('end 2'));
    expect(events.indexOf('dispose v1')).toBeGreaterThan(events.indexOf('end 3'));
    // A lease taken after the swap uses the new instance and does not resurrect the old one.
    await slot.use(i => { expect(i.key).toBe('v2'); }); await tick();
    expect(events.filter(e => e.startsWith('dispose'))).toEqual(['dispose v1']);
    await slot.close(); await tick();
    expect(events.filter(e => e.startsWith('dispose'))).toEqual(['dispose v1', 'dispose v2']);
  });

  it('never lets an older build that finishes late replace a newer instance', async () => {
    const { state, src } = scripted(), disposed: string[] = [];
    state.loadDelay = revision => revision === 1 ? 60 : 0;
    const slot = new RuntimeProviderSlot(src, { profiles: ['p'], freshness: 'strict', build: env => ({ key: env.KEY }), dispose: i => { disposed.push(i.key); } });
    const slow = slot.get();           // starts building revision 1, slowly
    await tick(5);
    state.revision = 2;
    const fast = await slot.get();     // revision 2 builds immediately
    expect(fast.key).toBe('v2');
    const late = await slow;           // the old build settles afterwards
    // The late caller may be served the newer instance, but the slot must now serve v2, never v1.
    expect(late.key).toBe('v2');
    expect((await slot.get()).key).toBe('v2');
    expect(slot.state().revisions?.get('p')).toBe(2);
    await tick(10);
    expect(disposed).toEqual(['v1']);
  });

  it('does not rebuild or serve a lower revision when the source briefly reports an older one', async () => {
    const { state, src } = scripted(); const build = vi.fn((env: Readonly<NodeJS.ProcessEnv>) => ({ key: env.KEY }));
    const slot = new RuntimeProviderSlot(src, { profiles: ['p'], freshness: 'ttl', build });
    state.revision = 3; await slot.get();
    state.revision = 2;                // e.g. a lagging replica or stale ttl cache
    expect((await slot.get()).key).toBe('v3');
    expect(build).toHaveBeenCalledTimes(1);
  });

  it('shares one failing build among concurrent callers, reports it once and never leaks the builder message', async () => {
    const { state, src } = scripted(); const onBuildError = vi.fn();
    let fail = false;
    const build = vi.fn(async (env: Readonly<NodeJS.ProcessEnv>) => { await tick(5); if (fail) throw new Error('SYNTHETIC-LEAK-IN-BUILDER-MESSAGE'); return { key: env.KEY }; });
    const slot = new RuntimeProviderSlot(src, { profiles: ['p'], freshness: 'strict', build, onBuildError });
    const first = await slot.get();
    fail = true; state.revision = 2;
    const results = await Promise.all(Array.from({ length: 8 }, () => slot.get()));
    for (const result of results) expect(result).toBe(first);
    expect(build).toHaveBeenCalledTimes(2); expect(onBuildError).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(slot.state(), (_k, v) => v instanceof Map ? [...v] : v)).not.toContain('SYNTHETIC-LEAK');
  });
});
