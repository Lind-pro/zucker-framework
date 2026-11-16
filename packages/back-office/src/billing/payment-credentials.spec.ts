import { describe, expect, it, vi } from 'vitest';
import type { HostedCheckoutAdapter, HostedCheckoutOrder } from '@zucker-framework/payment';
import { PaymentCredentialResolver, type PaymentCredentialSettings } from './payment-credentials';

function fixture(baseMode: string, saved: Record<number, { mode: string; scope?: string }> = {}, bootstrap: 'enabled' | 'disabled' | 'broken' = 'enabled') {
  const environment = (mode: string, scope = 'same-account') => ({ MODE: mode, SCOPE: scope });
  const adapters = new Map<string, HostedCheckoutAdapter>();
  const settings: PaymentCredentialSettings = {
    runtime: { base: environment(baseMode) },
    currentRevision: async () => Math.max(0, ...Object.keys(saved).map(Number)),
    revisions: async () => Object.keys(saved).map(Number).map(revision => ({ revision, createdAt: new Date(revision) })),
    environmentAt: async (_profile, revision) => saved[revision] && environment(saved[revision].mode, saved[revision].scope),
  };
  const factory = vi.fn((env: NodeJS.ProcessEnv) => {
    if (env.MODE === baseMode && bootstrap === 'disabled') return undefined;
    if (env.MODE === baseMode && bootstrap === 'broken') throw new Error('Synthetic assembly failure');
    const adapter: HostedCheckoutAdapter = {
      id: 'stripe', accountScope: env.SCOPE!, modes: ['payment'], validate() {},
      async create() { throw new Error('Synthetic adapter must not dispatch'); },
      async retrieve() { throw new Error('Synthetic adapter must not retrieve'); },
      async verifyWebhook() { return null; },
    };
    adapters.set(`${env.SCOPE}:${env.MODE}`, adapter);
    return { checkout: adapter };
  });
  const resolver = new PaymentCredentialResolver(settings, { profiles: {
    stripe: { profileId: 'payment-stripe', modeKey: 'MODE', scopeKey: 'SCOPE', webhookKeys: [] },
  }, factory });
  const order = (configRevision: string | null = 'payment-stripe@0', accountScope = 'same-account') =>
    ({ providerId: 'stripe', accountScope, configRevision }) as HostedCheckoutOrder;
  return { resolver, adapters, order, factory };
}

describe('payment credential resolution across modes', () => {
  it.each([['test', 'live'], ['live', 'test']])('keeps revision-zero %s orders on their original mode after switching to %s', async (before, after) => {
    const f = fixture(before, { 1: { mode: after } });
    const current = await f.resolver.current('stripe');
    const existing = await f.resolver.forOrder(f.order());
    expect(current?.adapter).toBe(f.adapters.get(`same-account:${after}`));
    expect(existing).toBe(f.adapters.get(`same-account:${before}`));
    expect(await f.resolver.resolveRevision('stripe', 'same-account', 'payment-stripe@0', true)).toBe(0);
  });
  it('keeps legacy null revision orders on the bootstrap mode', async () => {
    const f = fixture('test', { 1: { mode: 'live' } });
    expect(await f.resolver.forOrder(f.order(null))).toBe(f.adapters.get('same-account:test'));
  });
  it('still rotates revision-zero orders to a newer credential within the same mode', async () => {
    const f = fixture('test', { 1: { mode: 'test' }, 2: { mode: 'live' } });
    expect(await f.resolver.resolveRevision('stripe', 'same-account', 'payment-stripe@0', true)).toBe(1);
  });
  it('refuses a revision-zero order forged with another account scope', async () => {
    const f = fixture('test', { 1: { mode: 'test', scope: 'another-account' } });
    await expect(f.resolver.forOrder(f.order('payment-stripe@0', 'another-account'))).rejects.toMatchObject({ code: 'verification_failed' });
  });
  it.each(['disabled', 'broken'] as const)('fails closed when revision zero is %s and cannot prove the order mode', async (bootstrap) => {
    const f = fixture('test', { 1: { mode: 'live' } }, bootstrap);
    await expect(f.resolver.forOrder(f.order())).rejects.toMatchObject({ code: 'verification_failed' });
    expect((await f.resolver.current('stripe'))?.adapter).toBe(f.adapters.get('same-account:live'));
  });
  it('preserves the recorded mode for non-zero revisions', async () => {
    const f = fixture('test', { 1: { mode: 'live' }, 2: { mode: 'test' } });
    expect(await f.resolver.resolveRevision('stripe', 'same-account', 'payment-stripe@1', true)).toBe(1);
  });
});
