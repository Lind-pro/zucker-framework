import { afterEach, describe, expect, it, vi } from 'vitest';
import { TokenService } from './token.service';

describe('TokenService without cache revocation', () => {
  afterEach(() => vi.useRealTimers());
  it('retains a tombstone after signOut and expires it only at configured TTL', async () => {
    vi.useFakeTimers();
    const service = new TokenService();
    service.configure({ blacklistTtlMs: 1000 });
    await service.signIn('owner', 'synthetic-token');
    await service.revokeToken('synthetic-token');
    expect(await service.getByToken('synthetic-token')).toBeNull();
    expect(await service.isBlacklisted('synthetic-token')).toBe(true);
    await service.signOut('synthetic-token');
    await service.signIn('owner', 'synthetic-token');
    expect(await service.isBlacklisted('synthetic-token')).toBe(true);
    vi.advanceTimersByTime(999);
    expect(await service.isBlacklisted('synthetic-token')).toBe(true);
    vi.advanceTimersByTime(1);
    expect(await service.isBlacklisted('synthetic-token')).toBe(false);
  });
  it('revokes stateless JWTs even when they never had a local session', async () => {
    const service = new TokenService();
    await service.revokeToken('legacy-stateless');
    expect(await service.isBlacklisted('legacy-stateless')).toBe(true);
    expect(await service.isBlacklisted('other')).toBe(false);
  });
  it('revokes all user sessions without deleting their denial evidence', async () => {
    const service = new TokenService();
    await service.signIn('owner', 'one'); await service.signIn('owner', 'two');
    await service.revokeUserTokens('owner');
    expect(await service.getByUserId('owner')).toEqual([]);
    expect(await service.isBlacklisted('one')).toBe(true);
    expect(await service.isBlacklisted('two')).toBe(true);
  });
});
