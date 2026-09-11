import { describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '@zucker-framework/core';
import { PersistentSessionService } from './persistent-session.service';

function harness() {
  const session = {
    id: 's1',
    userId: 'u1',
    refreshJti: 'old',
    expiresAt: new Date(Date.now() + 60_000),
    revokedAt: null as Date | null,
  };
  const model = {
    findUnique: vi.fn(async () => ({ ...session })),
    findMany: vi.fn(async () => [session]),
    update: vi.fn(async ({ data }) => Object.assign(session, data)),
    updateMany: vi.fn(async ({ where, data }) => {
      if (
        where.refreshJti &&
        (where.refreshJti !== session.refreshJti ||
          session.revokedAt ||
          session.expiresAt <= new Date())
      )
        return { count: 0 };
      Object.assign(session, data);
      return { count: 1 };
    }),
  };
  const db = {
    model: () => model,
    $transaction: async (run: (db: DatabaseAdapter) => unknown) =>
      run(db as unknown as DatabaseAdapter),
  };
  const cache = { get: vi.fn(async () => null), set: vi.fn(), del: vi.fn() };
  return {
    session,
    model,
    db,
    cache,
    service: new PersistentSessionService(db as unknown as DatabaseAdapter, {
      modelName: 'sessions',
      sessionTtlMs: 60_000,
      cache,
    }),
  };
}

describe('PersistentSessionService', () => {
  it('uses durable state after restart even when cache operations fail', async () => {
    const h = harness();
    h.cache.get.mockRejectedValue(new Error('cache offline'));
    h.cache.set.mockRejectedValue(new Error('cache offline'));
    await expect(h.service.isSessionRevoked('s1')).resolves.toBe(false);
    await h.service.revokeSession('s1', 'logout');
    const restarted = new PersistentSessionService(h.db as unknown as DatabaseAdapter, {
      modelName: 'sessions',
      sessionTtlMs: 60_000,
      cache: h.cache,
    });
    await expect(restarted.isSessionRevoked('s1')).resolves.toBe(true);
  });

  it('does not trust positive cache entries across revocation or expiry', async () => {
    const h = harness();
    h.cache.get.mockImplementation(async (key?: string) =>
      key?.includes('active:') ? ('1' as never) : null,
    );
    h.session.revokedAt = new Date();
    await expect(h.service.isSessionRevoked('s1')).resolves.toBe(true);
    h.session.revokedAt = null;
    h.session.expiresAt = new Date(Date.now() - 1);
    await expect(h.service.isSessionRevoked('s1')).resolves.toBe(true);
    expect(h.cache.get.mock.calls.flat()).not.toContain('session:active:s1');
  });

  it('rejects missing sessions and propagates database outages', async () => {
    const h = harness();
    h.model.findUnique.mockResolvedValueOnce(null as never);
    await expect(h.service.isSessionRevoked('missing')).resolves.toBe(true);
    h.model.findUnique.mockRejectedValueOnce(new Error('database offline'));
    await expect(h.service.isSessionRevoked('s1')).rejects.toThrow('database offline');
  });

  it('allows only one competing refresh and rejects replay, no-op, revoked and expired refreshes', async () => {
    const h = harness();
    expect(
      (
        await Promise.all([
          h.service.rotateRefreshJti('s1', 'old', 'new1'),
          h.service.rotateRefreshJti('s1', 'old', 'new2'),
        ])
      ).filter(Boolean),
    ).toHaveLength(1);
    await expect(h.service.rotateRefreshJti('s1', 'old', 'new3')).resolves.toBe(false);
    await expect(h.service.rotateRefreshJti('s1', 'new1', 'new1')).resolves.toBe(false);
    h.session.revokedAt = new Date();
    await expect(h.service.rotateRefreshJti('s1', 'new1', 'new4')).resolves.toBe(false);
    h.session.revokedAt = null;
    h.session.expiresAt = new Date(0);
    await expect(h.service.rotateRefreshJti('s1', 'new1', 'new4')).resolves.toBe(false);
  });

  it('scopes bulk revocation to the user and preserves the selected session', async () => {
    const h = harness();
    await expect(h.service.revokeAllOtherSessions('u1', 'keep', 'password_changed')).resolves.toBe(
      1,
    );
    expect(h.model.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'u1', revokedAt: null, id: { not: 'keep' } } }),
    );
    expect(h.model.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ['s1'] } } }),
    );
  });
});

describe('owner-constrained session revocation', () => {
  it('does not create a revocation cache entry when the database reports no owned row', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const set = vi.fn();
    const service = new PersistentSessionService(
      { model: () => ({ updateMany }) } as unknown as DatabaseAdapter,
      { modelName: 'sessions', sessionTtlMs: 60_000, cache: { get: vi.fn(), set, del: vi.fn() } },
    );
    expect(await service.revokeSessionForUser('session', 'visitor', 'logout')).toBe(false);
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'session', userId: 'visitor' } }),
    );
    expect(set).not.toHaveBeenCalled();
  });
  it('persists the owner condition before marking the session revoked in cache', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const set = vi.fn().mockRejectedValue(new Error('cache unavailable'));
    const service = new PersistentSessionService(
      { model: () => ({ updateMany }) } as unknown as DatabaseAdapter,
      { modelName: 'sessions', sessionTtlMs: 60_000, cache: { get: vi.fn(), set, del: vi.fn() } },
    );
    expect(await service.revokeSessionForUser('session', 'owner', 'logout')).toBe(true);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'session', userId: 'owner' },
      data: { revokedAt: expect.any(Date), revokedReason: 'logout' },
    });
    expect(set).toHaveBeenCalledWith('session:revoked:session', '1', 3_600_000);
  });
});
