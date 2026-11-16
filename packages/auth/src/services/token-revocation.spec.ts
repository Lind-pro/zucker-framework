import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthGuard } from '@nestjs/passport';
import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import { MemoryCache } from '@zucker-framework/cache';
import { TokenService } from './token.service';
import { UserService } from './user.service';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { TokenState } from '../interfaces';

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

function jwt(payload: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'HS256', typ: 'JWT' })}.${part(payload)}.signature`;
}
const nowSec = () => Math.floor(Date.now() / 1000);

function context(token: string): ExecutionContext {
  const request = { headers: { authorization: `Bearer ${token}` }, user: { id: 'u1' } };
  return { switchToHttp: () => ({ getRequest: () => request }), getHandler: () => () => {}, getClass: () => class {} } as unknown as ExecutionContext;
}

describe('TokenService revocation (H3)', () => {
  it('keeps a tracked token revoked when earlier replica writes arrive after a later revocation', async () => {
    let release!: () => void;
    let started!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { started = resolve; });
    class DelayedCache extends MemoryCache {
      private first = true;
      override async advanceSequence(key: string, minimum: number, ttlMs: number): Promise<number> {
        if (this.first) { this.first = false; started(); await pending; }
        return super.advanceSequence(key, minimum, ttlMs);
      }
    }
    const shared = new DelayedCache();
    const early = new TokenService(shared), late = new TokenService(shared), issuer = new TokenService(shared);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
    try {
      const first = early.revokeUserTokens('owner');
      await ready;
      clock.mockReturnValue(2000);
      await issuer.signIn('owner', 'tracked');
      clock.mockReturnValue(3000);
      const secondWatermark = await late.revokeUserTokens('owner');
      const claims = { sub: 'owner', iat: 2, sessionTracked: true };
      expect(await issuer.checkAccessToken('tracked', claims)).toBe('user_revoked');
      release();
      expect(await first).toBeGreaterThan(secondWatermark);
      expect(await issuer.checkAccessToken('tracked', claims)).toBe('user_revoked');
    } finally { release(); clock.mockRestore(); }
  });

  it('fails closed instead of falling back to non-atomic cache writes', async () => {
    const cache = { get: vi.fn(), set: vi.fn(), has: async () => false, del: vi.fn(), clear: vi.fn() };
    const service = new TokenService(cache);
    await expect(service.revokeUserTokens('owner')).rejects.toThrow('atomic advanceSequence');
    expect(cache.set).not.toHaveBeenCalled();
    await expect(service.checkAccessToken('token', { sub: 'owner' })).rejects.toThrow('authoritative readSequence');
  });

  it('gives simultaneous local revocations different watermarks within the same millisecond', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
    try {
      const service = new TokenService();
      expect(new Set(await Promise.all(Array.from({ length: 8 }, () => service.revokeUserTokens('owner')))).size).toBe(8);
    } finally { clock.mockRestore(); }
  });

  it('blacklists signed-out tokens', async () => {
    const tokens = new TokenService();
    const token = jwt({ sub: 'u1', iat: nowSec() });
    await tokens.signIn('u1', token);
    await tokens.signOut(token);
    expect(await tokens.checkAccessToken(token, { sub: 'u1', iat: nowSec() })).toBe('revoked');
  });

  it('kicks a user on every instance sharing the cache, including unknown tokens', async () => {
    const shared = new MemoryCache();
    const a = new TokenService(shared);
    const b = new TokenService(shared);
    const issuedBefore = nowSec() - 5;
    const token = jwt({ sub: 'u1', iat: issuedBefore });
    // Token issued by instance B (or before a restart): instance A never saw it.
    await b.signIn('u1', token);
    await a.signOutByUserId('u1');
    expect(await b.checkAccessToken(token, { sub: 'u1', iat: issuedBefore })).not.toBeNull();
    expect(await a.checkAccessToken('other-token', { sub: 'u1', iat: issuedBefore })).toBe('user_revoked');
    // A token issued after the revocation second is accepted.
    expect(await a.checkAccessToken('new-token', { sub: 'u1', iat: nowSec() + 2 })).toBeNull();
    expect(await a.checkAccessToken('x', { sub: 'u2', iat: issuedBefore })).toBeNull();
  });

  it('rejects locked or offline sessions and blacklists terminal states', async () => {
    const tokens = new TokenService();
    await tokens.signIn('u1', 't1');
    await tokens.changeState('t1', TokenState.LOCK);
    expect(await tokens.checkAccessToken('t1', { sub: 'u1', iat: nowSec() })).toBe('inactive');
    await tokens.changeState('t1', TokenState.NORMAL);
    expect(await tokens.checkAccessToken('t1', { sub: 'u1', iat: nowSec() })).toBeNull();
    await tokens.changeState('t1', TokenState.OFFLINE);
    expect(await tokens.isBlacklisted('t1')).toBe(true);
  });

  it('enforces maxInactiveInterval at request time', async () => {
    const tokens = new TokenService();
    const info = await tokens.signIn('u1', 't1', 'default', 1000);
    info.lastRequestTime = new Date(Date.now() - 5000);
    expect(await tokens.checkAccessToken('t1', { sub: 'u1', iat: nowSec() })).not.toBeNull();
  });

  it('JwtAuthGuard rejects tokens of a user revoked on another instance', async () => {
    const base = vi.spyOn(AuthGuard('jwt').prototype, 'canActivate').mockResolvedValue(true);
    try {
      const shared = new MemoryCache();
      const token = jwt({ sub: 'u1', iat: nowSec() - 10 });
      const guard = new JwtAuthGuard(new Reflector(), new TokenService(shared));
      await expect(guard.canActivate(context(token))).resolves.toBe(true);
      await new TokenService(shared).revokeUserTokens('u1');
      await expect(guard.canActivate(context(token))).rejects.toThrow('Token 已被撤销');
    } finally { base.mockRestore(); }
  });
});

describe('UserService session revocation (H4)', () => {
  function db(user: Record<string, unknown>) {
    const model = {
      findUnique: vi.fn().mockResolvedValue(user),
      findMany: vi.fn().mockResolvedValue([user]),
      update: vi.fn().mockResolvedValue(user),
      delete: vi.fn(), deleteMany: vi.fn(),
    };
    return { model: () => model, $transaction: async (work: (tx: unknown) => unknown) => work({ model: () => model }) };
  }

  it('revokes tokens when a user is disabled, deleted or changes password', async () => {
    const tokens = new TokenService();
    const revoke = vi.spyOn(tokens, 'revokeUserTokens');
    const encoder = { encode: async (v: string) => `h:${v}`, matches: async (raw: string, hash: string) => hash === `h:${raw}` };
    const users = new UserService(db({ id: 'u1', username: 'a', status: true, password: 'h:Old-password1!' }) as never, encoder, undefined, tokens);
    await users.changeState(['u1'], false);
    await users.changePassword('u1', 'Old-password1!', 'New-password2@');
    await users.deleteUser('u1', []);
    expect(revoke).toHaveBeenCalledTimes(3);
    expect(await tokens.checkAccessToken('any', { sub: 'u1', iat: nowSec() - 1 })).toBe('user_revoked');
  });
});
