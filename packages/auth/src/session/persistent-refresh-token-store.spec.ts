// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { InMemoryAdapter } from '@zucker-framework/crud';
import { PersistentSessionService } from './persistent-session.service';
import { PersistentSessionRefreshTokenStore } from './persistent-refresh-token-store';
import { RefreshTokenService } from './refresh-token.service';

async function fixture() {
  const db = new InMemoryAdapter();
  const sessions = new PersistentSessionService(db, { modelName: 'sessions', sessionTtlMs: 60_000 });
  await sessions.createSession({ id: 'session', userId: 'owner', refreshJti: 'initial', revokedAt: null, lastActiveAt: new Date() });
  const store = new PersistentSessionRefreshTokenStore(sessions);
  const create = () => new RefreshTokenService({
    store: new PersistentSessionRefreshTokenStore(new PersistentSessionService(db, { modelName: 'sessions', sessionTtlMs: 60_000 })),
    accessTtlSeconds: 10, refreshTtlSeconds: 60,
    verify: token => ({ subject: 'session', jti: token }),
    loadIdentity: async () => ({ id: 'owner' }),
    issue: (_identity, claims) => ({ accessToken: 'access', refreshToken: claims.jti }),
  });
  return { db, sessions, store, create };
}

describe('persistent refresh transport', () => {
  it('rotates across separate service instances and returns exactly one concurrent winner', async () => {
    const f = await fixture();
    const issued = await f.create().login('session', { id: 'owner' });
    const results = await Promise.allSettled([f.create().refresh(issued.refreshToken), f.create().refresh(issued.refreshToken)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
  });
  it('cannot revive revoked or missing sessions, even when legacy cache recovery is requested', async () => {
    const f = await fixture();
    await f.store.revoke('session', 60_000);
    await expect(f.store.replace('session', 'new', 60_000)).rejects.toThrow();
    await expect(f.store.canRotate('session', 'initial', true)).resolves.toBe(false);
    await expect(f.store.rotate('session', 'initial', 'new', 60_000, true)).resolves.toBe(false);
    await expect(f.store.canRotate('missing', 'initial', true)).resolves.toBe(false);
    await expect(f.store.replace('missing', 'new', 60_000)).rejects.toThrow();
  });
  it('retains the durable expiry and never mistakes a refresh JTI for a session ID', async () => {
    const f = await fixture();
    const expiresAt = (await f.sessions.getSessionById('session'))!.expiresAt;
    await f.store.replace('session', 'current', 999_999);
    expect((await f.sessions.getSessionById('session'))!.expiresAt).toEqual(expiresAt);
    await expect(f.store.canRotate('current', 'current', false)).resolves.toBe(false);
    await f.db.model('sessions').update({ where: { id: 'session' }, data: { expiresAt: new Date(0) } });
    await expect(f.store.rotate('session', 'current', 'new', 60_000, false)).resolves.toBe(false);
    await expect(f.store.replace('session', 'new', 60_000)).rejects.toThrow();
  });

  describe('refresh-token reuse detection', () => {
    const age = (f: Awaited<ReturnType<typeof fixture>>, ms: number) =>
      f.db.model('sessions').update({ where: { id: 'session' }, data: { lastActiveAt: new Date(Date.now() - ms) } });

    it('revokes the session (and its successor token) when an old token is reused after the grace window', async () => {
      const f = await fixture();
      const service = f.create();
      const first = await service.login('session', { id: 'owner' });
      const second = await service.refresh(first.refreshToken);
      await age(f, 60_000);
      await expect(service.refresh(first.refreshToken)).rejects.toMatchObject({ reason: 'replayed' });
      const session = await f.sessions.getSessionById('session');
      expect(session).toMatchObject({ revokedReason: 'refresh_reuse' });
      expect(session!.revokedAt).toBeInstanceOf(Date);
      // The legitimate successor is dead too; access tokens bound to the session fail the session check.
      await expect(service.refresh(second.refreshToken)).rejects.toMatchObject({ reason: 'replayed' });
      expect(await f.sessions.isSessionRevoked('session')).toBe(true);
    });
    it('only rejects a reuse inside the grace window (a client retrying a lost response stays signed in)', async () => {
      const f = await fixture();
      const service = f.create();
      const first = await service.login('session', { id: 'owner' });
      const second = await service.refresh(first.refreshToken);
      await expect(service.refresh(first.refreshToken)).rejects.toMatchObject({ reason: 'replayed' });
      expect((await f.sessions.getSessionById('session'))!.revokedAt).toBeNull();
      await expect(service.refresh(second.refreshToken)).resolves.toMatchObject({ accessToken: 'access' });
    });
    it('never revokes the loser of a concurrent rotation of the current token', async () => {
      const f = await fixture();
      const issued = await f.create().login('session', { id: 'owner' });
      await age(f, 60_000);
      const results = await Promise.allSettled([f.create().refresh(issued.refreshToken), f.create().refresh(issued.refreshToken)]);
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      expect((await f.sessions.getSessionById('session'))!.revokedAt).toBeNull();
    });
    it('can be switched off', async () => {
      const f = await fixture();
      const service = new RefreshTokenService({
        store: f.store, accessTtlSeconds: 10, refreshTtlSeconds: 60, reuseDetection: false,
        verify: token => ({ subject: 'session', jti: token }), loadIdentity: async () => ({ id: 'owner' }),
        issue: (_identity, claims) => ({ accessToken: 'access', refreshToken: claims.jti }),
      });
      const first = await service.login('session', { id: 'owner' });
      await service.refresh(first.refreshToken);
      await age(f, 60_000);
      await expect(service.refresh(first.refreshToken)).rejects.toMatchObject({ reason: 'replayed' });
      expect((await f.sessions.getSessionById('session'))!.revokedAt).toBeNull();
      expect(() => new RefreshTokenService({ ...{ store: f.store, accessTtlSeconds: 10, refreshTtlSeconds: 60,
        verify: () => ({ subject: 's', jti: 'j' }), loadIdentity: async () => null, issue: () => ({ accessToken: 'a', refreshToken: 'r' }) },
        reuseDetection: { graceMs: -1 } })).toThrow(RangeError);
    });
  });
});
