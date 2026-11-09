import { afterEach, describe, expect, it, vi } from 'vitest';

const load = async () => {
  vi.resetModules();
  return import('./operation-attempt');
};

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe('operation attempts', () => {
  it('keeps independent keys per intent and actor, survives reload and stores no form contents', async () => {
    const attempts = await load();
    const body = { owner: 'member-a', amount: 10, reason: 'PRIVATE-REASON' };
    const first = await attempts.operationAttempt('credit-grant', 'actor-a', body);
    const second = await attempts.operationAttempt('credit-grant', 'actor-a', { owner: 'member-b', amount: 20 });
    const refund = await attempts.operationAttempt('refund', 'actor-a', body);
    const otherActor = await attempts.operationAttempt('credit-grant', 'actor-b', body);
    expect(new Set([first.key, second.key, refund.key, otherActor.key]).size).toBe(4);
    expect(first.existing).toBe(false);

    const reloaded = await load();
    const retried = await reloaded.operationAttempt('credit-grant', 'actor-a', body);
    expect(retried.key).toBe(first.key);
    expect(retried.existing).toBe(true);
    expect((await reloaded.findOperationAttempt('refund', 'actor-a', body))?.key).toBe(refund.key);

    reloaded.clearOperationAttempt('credit-grant', 'actor-a', first.key);
    expect(await reloaded.findOperationAttempt('credit-grant', 'actor-a', body)).toBeNull();
    expect((await reloaded.operationAttempt('credit-grant', 'actor-a', { owner: 'member-b', amount: 20 })).key).toBe(second.key);

    const stored = Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.getItem(sessionStorage.key(index)!)).join('');
    expect(stored).not.toMatch(/PRIVATE-REASON|member-a|member-b|amount/);
  });

  it('keeps a stable key in memory when storage is blocked and reports it', async () => {
    const attempts = await load();
    vi.stubGlobal('sessionStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      get length() {
        return 0;
      },
    });
    const first = await attempts.operationAttempt('refund', 'actor-a', { target: 'order' });
    expect(first.persisted).toBe(false);
    expect((await attempts.operationAttempt('refund', 'actor-a', { target: 'order' })).key).toBe(first.key);
  });

  it('works outside a secure context (no crypto.subtle / randomUUID)', async () => {
    const attempts = await load();
    const real = globalThis.crypto;
    vi.stubGlobal('crypto', { getRandomValues: (bytes: Uint8Array<ArrayBuffer>) => real.getRandomValues(bytes) });
    const body = { owner: 'member-a', amount: 10 };
    const first = await attempts.operationAttempt('credit-grant', 'actor-a', body);
    expect(first.key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(first.fingerprint).toMatch(/^fnv-[0-9a-f]{32}$/);
    // Deterministic: the same intent finds the same pending key, also after a reload.
    expect((await attempts.operationAttempt('credit-grant', 'actor-a', body)).key).toBe(first.key);
    const reloaded = await load();
    expect((await reloaded.findOperationAttempt('credit-grant', 'actor-a', body))?.key).toBe(first.key);
    expect((await reloaded.operationAttempt('credit-grant', 'actor-a', { ...body, amount: 11 })).key).not.toBe(first.key);
  });
});

