import { describe, expect, it, vi } from 'vitest';
import { JwtService } from '@nestjs/jwt';
import { CacheRefreshTokenStore, InProcessRefreshTokenLock, RefreshTokenError, RefreshTokenService } from './refresh-token.service';

function fixture(policy: 'recover' | 'reject' = 'recover') {
  const values = new Map<string, unknown>();
  const cache = {
    get: vi.fn(async (key: string) => values.get(key)),
    set: vi.fn(async (key: string, value: unknown, _ttl: number) => { values.set(key, value); }),
  };
  const store = new CacheRefreshTokenStore({ cache, key: id => `refresh_token:${id}`, lock: new InProcessRefreshTokenLock() });
  const jwt = new JwtService({ secret: 'synthetic-refresh-test-secret' });
  const loadIdentity = vi.fn(async (id: string): Promise<{ id: string; permissions: string[] } | null> => ({ id, permissions: ['fresh:read'] }));
  const issue = vi.fn((identity: { id: string; permissions: string[] }, claims: { subject: string; jti: string }, ttl: { accessTtlSeconds: number; refreshTtlSeconds: number }) => ({
    accessToken: jwt.sign({ sub: claims.subject, permissions: identity.permissions, tokenType: 'access' }, { expiresIn: ttl.accessTtlSeconds }),
    refreshToken: jwt.sign({ sub: claims.subject, tokenType: 'refresh', jti: claims.jti }, { expiresIn: ttl.refreshTtlSeconds }),
  }));
  const service = new RefreshTokenService({ store, loadIdentity, issue, accessTtlSeconds: 7 * 86400, refreshTtlSeconds: 30 * 86400, cacheMissPolicy: policy,
    verify: token => {
      const claims = jwt.verify(token);
      if (claims.tokenType !== 'refresh') throw new RefreshTokenError('invalid');
      return { subject: claims.sub, jti: claims.jti };
    },
  });
  const legacy = (jti = 'old-jti') => jwt.sign({ sub: 'owner', tokenType: 'refresh', jti }, { expiresIn: '30d' });
  return { service, store, jwt, values, cache, loadIdentity, issue, legacy };
}

describe('refresh pair lifecycle over existing JTI cache', () => {
  it('preserves legacy key/string values and explicit access 7d / refresh 30d lifetimes', async () => {
    const f = fixture();
    const pair = await f.service.login('owner', { id: 'owner', permissions: ['login:read'] });
    const access = f.jwt.verify(pair.accessToken), refresh = f.jwt.verify(pair.refreshToken);
    expect(access.exp - access.iat).toBe(7 * 86400);
    expect(refresh.exp - refresh.iat).toBe(30 * 86400);
    expect(f.values.get('refresh_token:owner')).toBe(refresh.jti);
    expect(f.cache.set).toHaveBeenLastCalledWith('refresh_token:owner', refresh.jti, 30 * 86400 * 1000);
    const rotated = await f.service.refresh(pair.refreshToken);
    expect(f.jwt.verify(rotated.accessToken).permissions).toEqual(['fresh:read']);
    await expect(f.service.refresh(pair.refreshToken)).rejects.toMatchObject({ reason: 'replayed' });
  });

  it.each([true, false])('only one concurrent rotation succeeds (existing key: %s)', async existing => {
    const f = fixture();
    if (existing) f.values.set('refresh_token:owner', 'old-jti');
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => f.service.refresh(f.legacy())));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(11);
  });

  it('rejects a cache miss by default policy and corrupt/revoked cache values even with recovery', async () => {
    const strict = fixture('reject');
    await expect(strict.service.refresh(strict.legacy())).rejects.toMatchObject({ reason: 'replayed' });
    for (const value of ['', false, {}, { revoked: true }]) {
      const f = fixture(); f.values.set('refresh_token:owner', value);
      await expect(f.service.refresh(f.legacy())).rejects.toMatchObject({ reason: 'replayed' });
    }
  });

  it('logout denies legacy recovery and a refresh already loading identity', async () => {
    const f = fixture();
    let resume!: () => void;
    const gate = new Promise<void>(resolve => { resume = resolve; });
    f.loadIdentity.mockImplementationOnce(async id => { await gate; return { id, permissions: [] }; });
    const pending = f.service.refresh(f.legacy());
    await f.service.revoke('owner'); resume();
    await expect(pending).rejects.toMatchObject({ reason: 'replayed' });
    await expect(f.service.refresh(f.legacy())).rejects.toMatchObject({ reason: 'replayed' });
    const pair = await f.service.login('owner', { id: 'owner', permissions: [] });
    await expect(f.service.refresh(pair.refreshToken)).resolves.toHaveProperty('accessToken');
  });

  it('a concurrent login invalidates a pending old refresh', async () => {
    const f = fixture();
    let resume!: () => void;
    const gate = new Promise<void>(resolve => { resume = resolve; });
    f.loadIdentity.mockImplementationOnce(async id => { await gate; return { id, permissions: [] }; });
    const pending = f.service.refresh(f.legacy());
    await f.service.login('owner', { id: 'owner', permissions: [] }); resume();
    await expect(pending).rejects.toMatchObject({ reason: 'replayed' });
  });

  it('rejects known replay before identity lookup and propagates cache read failure', async () => {
    const f = fixture();
    f.values.set('refresh_token:owner', 'another-jti');
    await expect(f.service.refresh(f.legacy())).rejects.toMatchObject({ reason: 'replayed' });
    expect(f.loadIdentity).not.toHaveBeenCalled();
    const error = new Error('synthetic cache unavailable');
    f.cache.get.mockRejectedValueOnce(error);
    await expect(f.service.refresh(f.legacy())).rejects.toBe(error);
    expect(f.issue).not.toHaveBeenCalled();
  });

  it('propagates infrastructure errors and does not consume on loader/signer failure', async () => {
    const f = fixture(); f.values.set('refresh_token:owner', 'old-jti');
    const error = new Error('synthetic unavailable');
    f.loadIdentity.mockRejectedValueOnce(error);
    await expect(f.service.refresh(f.legacy())).rejects.toBe(error);
    f.issue.mockImplementationOnce(() => { throw error; });
    await expect(f.service.refresh(f.legacy())).rejects.toBe(error);
    expect(f.values.get('refresh_token:owner')).toBe('old-jti');
    f.cache.set.mockRejectedValueOnce(error);
    await expect(f.service.refresh(f.legacy())).rejects.toBe(error);
    await expect(f.service.refresh(f.legacy())).resolves.toHaveProperty('accessToken');
  });

  it.each(['', 'malformed', 'a.b.c'])('rejects invalid JWT %j without loading identity', async token => {
    const f = fixture();
    await expect(f.service.refresh(token)).rejects.toThrow();
    expect(f.loadIdentity).not.toHaveBeenCalled();
  });

  it('rejects expired/access/missing JTI JWT and missing identity', async () => {
    const f = fixture();
    for (const token of [f.jwt.sign({ sub: 'owner', tokenType: 'refresh', jti: 'old' }, { expiresIn: -1 }),
      f.jwt.sign({ sub: 'owner', tokenType: 'access' }), f.jwt.sign({ sub: 'owner', tokenType: 'refresh' })]) {
      await expect(f.service.refresh(token)).rejects.toThrow();
    }
    expect(f.loadIdentity).not.toHaveBeenCalled();
    f.loadIdentity.mockResolvedValueOnce(null);
    await expect(f.service.refresh(f.legacy())).rejects.toMatchObject({ reason: 'identity-missing' });
    expect(f.cache.set).not.toHaveBeenCalled();
  });
});
