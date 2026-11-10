import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { Global, Module, Injectable } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MemoryCache } from '@zucker-framework/cache';
import { DATABASE_ADAPTER } from '@zucker-framework/core';
import { TokenService, TOKEN_CACHE, tokenDigest } from './token.service';
import { AllopatricLoginMode } from '../interfaces';
import { readAccessTokenClaims } from '../guards/access-token-claims';
import { ZuckerAuthModule } from '../auth.module';

const HOUR = 3_600_000;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const nowSec = () => Math.floor(Date.now() / 1000);
function jwt(payload: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'HS256', typ: 'JWT' })}.${part(payload)}.signature`;
}

describe('TokenService shared session inactivity (N-H1)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('does not blacklist a session that is active on another instance', async () => {
    const cache = new MemoryCache();
    const a = new TokenService(cache);
    const b = new TokenService(cache);
    await a.signIn('user-1', 'tok-1', 'default', 2 * HOUR);

    // Only instance B sees traffic for 2.5 h (one touch per minute).
    for (let i = 0; i < 150; i++) {
      vi.advanceTimersByTime(60_000);
      await b.touch('tok-1');
    }
    // Instance A runs its own sweep (sign-in of someone else triggers checkExpired).
    await a.signIn('user-2', 'tok-2');

    const claims = { sub: 'user-1', iat: nowSec() - 3 * 3600, sessionTracked: true };
    expect(await a.checkAccessToken('tok-1', claims)).toBeNull();
    expect(await b.checkAccessToken('tok-1', claims)).toBeNull();
    expect(await a.isBlacklisted('tok-1')).toBe(false);
    expect(await b.isBlacklisted('tok-1')).toBe(false);
  });

  it('reports inactive on every instance once the session is idle everywhere', async () => {
    const cache = new MemoryCache();
    const a = new TokenService(cache);
    const b = new TokenService(cache);
    await a.signIn('user-1', 'tok-1', 'default', 60_000);
    vi.advanceTimersByTime(60_000 + 30_000 + 1_000);
    const claims = { sub: 'user-1', sessionTracked: true };
    expect(await a.checkAccessToken('tok-1', claims)).toBe('inactive');
    expect(await b.checkAccessToken('tok-1', claims)).toBe('inactive');
  });

  it('keeps enforcing inactivity from a fresh instance on the same cache', async () => {
    const cache = new MemoryCache();
    const a = new TokenService(cache);
    await a.signIn('user-1', 'tok-1', 'default', 60_000);
    const restarted = new TokenService(cache);
    const claims = { sub: 'user-1', sessionTracked: true };
    expect(await restarted.checkAccessToken('tok-1', claims)).toBeNull();
    vi.advanceTimersByTime(120_000);
    expect(await restarted.checkAccessToken('tok-1', claims)).toBe('inactive');
  });

  it('treats a missing shared record of a tracked token as inactive unless enforcement is disabled', async () => {
    const cache = new MemoryCache();
    const service = new TokenService(cache);
    const claims = { sub: 'user-1', sessionTracked: true };
    expect(await service.checkAccessToken('never-signed-in', claims)).toBe('inactive');
    // Untracked tokens (no zsess claim) are unaffected.
    expect(await service.checkAccessToken('never-signed-in', { sub: 'user-1' })).toBeNull();
    service.configure({ enforceSessionInactivity: false });
    expect(await service.checkAccessToken('never-signed-in', claims)).toBeNull();
  });
});

describe('TokenService blacklist keys', () => {
  it('writes token:blacklist:<sha256> and never the raw token', async () => {
    const cache = new MemoryCache();
    const service = new TokenService(cache);
    await service.signIn('u1', 'raw-secret-token');
    await service.revokeToken('raw-secret-token');
    expect(await cache.has(`token:blacklist:${sha('raw-secret-token')}`)).toBe(true);
    expect(await cache.has('token:blacklist:raw-secret-token')).toBe(false);
    expect(tokenDigest('raw-secret-token')).toBe(sha('raw-secret-token'));
  });

  it('still honours a legacy raw-token blacklist key written by older builds', async () => {
    const cache = new MemoryCache();
    await cache.set('token:blacklist:legacy-token', true, 60_000);
    const service = new TokenService(cache);
    expect(await service.isBlacklisted('legacy-token')).toBe(true);
    expect(await service.checkAccessToken('legacy-token', { sub: 'u1' })).toBe('revoked');
    expect(await service.isBlacklisted('other-token')).toBe(false);
  });
});

describe('TokenService revocation watermark claim rva (N-M2)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  for (const mode of ['process-local', 'shared cache'] as const) {
    it(`accepts a same-second token carrying the returned watermark (${mode})`, async () => {
      const service = new TokenService(mode === 'shared cache' ? new MemoryCache() : undefined);
      const watermark = await service.revokeUserTokens('u1');
      const iat = Math.floor(watermark / 1000);
      expect(await service.checkAccessToken('t-new', { sub: 'u1', iat, rva: watermark })).toBeNull();
      expect(await service.checkAccessToken('t-old', { sub: 'u1', iat })).toBe('user_revoked');
      expect(await service.checkAccessToken('t-older', { sub: 'u1', iat: iat - 10, rva: watermark - 5 })).toBe('user_revoked');
    });

    it(`rejects a token issued under an older watermark after a second revoke (${mode})`, async () => {
      const service = new TokenService(mode === 'shared cache' ? new MemoryCache() : undefined);
      const first = await service.revokeUserTokens('u1');
      const second = await service.revokeUserTokens('u1');
      expect(second).toBeGreaterThan(first);
      const iat = Math.floor(second / 1000);
      expect(await service.checkAccessToken('t1', { sub: 'u1', iat, rva: first })).toBe('user_revoked');
      expect(await service.checkAccessToken('t2', { sub: 'u1', iat, rva: second })).toBeNull();
    });
  }

  it('issueClaims embeds the tracking marker and the current watermark', async () => {
    const service = new TokenService(new MemoryCache());
    expect(await service.issueClaims('u1')).toEqual({ zsess: 1 });
    const watermark = await service.revokeUserTokens('u1');
    expect(await service.issueClaims('u1')).toEqual({ zsess: 1, rva: watermark });
  });
});

describe('TokenService shared session index across instances (N-L12)', () => {
  it('maxActiveSessions=1 revokes the other instance\'s token', async () => {
    const cache = new MemoryCache();
    const a = new TokenService(cache);
    const b = new TokenService(cache);
    a.configure({ maxActiveSessions: 1 });
    b.configure({ maxActiveSessions: 1 });
    await a.signIn('u1', 'tok-a');
    await b.signIn('u1', 'tok-b');
    expect(await a.checkAccessToken('tok-a', { sub: 'u1', sessionTracked: true })).toBe('revoked');
    expect(await b.checkAccessToken('tok-b', { sub: 'u1', sessionTracked: true })).toBeNull();
  });

  it('OFFLINE_OTHER kicks the session that lives on another instance', async () => {
    const cache = new MemoryCache();
    const a = new TokenService(cache);
    const b = new TokenService(cache);
    a.configure({ allopatricLoginMode: AllopatricLoginMode.OFFLINE_OTHER });
    b.configure({ allopatricLoginMode: AllopatricLoginMode.OFFLINE_OTHER });
    await a.signIn('u1', 'tok-a');
    await b.signIn('u1', 'tok-b');
    expect(await a.checkAccessToken('tok-a', { sub: 'u1', sessionTracked: true })).toBe('revoked');
    expect(await b.checkAccessToken('tok-b', { sub: 'u1', sessionTracked: true })).toBeNull();
    // Sessions of other users are untouched.
    await b.signIn('u2', 'tok-u2');
    expect(await a.checkAccessToken('tok-u2', { sub: 'u2', sessionTracked: true })).toBeNull();
  });

  it('DENY refuses a second login even when the first session lives on another instance', async () => {
    const cache = new MemoryCache();
    const a = new TokenService(cache);
    const b = new TokenService(cache);
    b.configure({ allopatricLoginMode: AllopatricLoginMode.DENY });
    await a.signIn('u1', 'tok-a');
    await expect(b.signIn('u1', 'tok-b')).rejects.toMatchObject({ code: 'ALLOPATRIC_LOGIN_DENIED' });
  });
});

describe('TokenService cache resolver (N-M1)', () => {
  it('resolves the cache at onApplicationBootstrap, not before', async () => {
    const cache = new MemoryCache();
    const service = new TokenService();
    service.setCacheResolver(() => cache);
    await service.signIn('u1', 'before-bootstrap');
    expect(await cache.has(`token:active:${sha('before-bootstrap')}`)).toBe(false);
    service.onApplicationBootstrap();
    await service.signIn('u1', 'after-bootstrap');
    expect(await cache.has(`token:active:${sha('after-bootstrap')}`)).toBe(true);
  });

  it('throws at bootstrap when the resolver returns nothing', () => {
    const service = new TokenService();
    service.setCacheResolver(() => undefined);
    expect(() => service.onApplicationBootstrap()).toThrow(/cacheProvider/);
  });
});

describe('ZuckerAuthModule.forRootAsync cacheProvider (N-M1)', () => {
  const CACHE_TOKEN = 'SYNTHETIC_AUTH_CACHE';

  @Global()
  @Module({
    providers: [{ provide: DATABASE_ADAPTER, useValue: { model: () => ({}) } }],
    exports: [DATABASE_ADAPTER],
  })
  class DatabaseModule {}

  async function boot(cacheModule: new () => unknown, asyncOptions: Record<string, unknown>) {
    @Module({
      imports: [
        DatabaseModule,
        // Auth is imported BEFORE the module that provides the cache.
        ZuckerAuthModule.forRootAsync({
          registerControllers: false,
          useFactory: () => ({ jwtSecret: 'unit-test-jwt-secret-0123456789abcdef' }),
          ...asyncOptions,
        } as never),
        cacheModule as never,
      ],
    })
    class AppModule {}
    return NestFactory.createApplicationContext(AppModule, { logger: false, abortOnError: false });
  }

  it('injects a top-level cacheProvider (factory provider) ahead of TokenService', async () => {
    const cache = new MemoryCache();
    @Global()
    @Module({ providers: [{ provide: CACHE_TOKEN, useFactory: () => cache }], exports: [CACHE_TOKEN] })
    class CacheModule {}
    const app = await boot(CacheModule, { cacheProvider: CACHE_TOKEN });
    try {
      const tokens = app.get(TokenService);
      await tokens.signIn('u1', 'tok');
      expect(await cache.has(`token:active:${sha('tok')}`)).toBe(true);
      expect(app.get(TOKEN_CACHE, { strict: false })).toBe(cache);
    } finally {
      await app.close();
    }
  });

  it('injects a top-level cacheProvider that is a class provider', async () => {
    @Injectable()
    class ClassCache extends MemoryCache {}
    @Global()
    @Module({ providers: [{ provide: CACHE_TOKEN, useClass: ClassCache }], exports: [CACHE_TOKEN] })
    class CacheModule {}
    const app = await boot(CacheModule, { cacheProvider: CACHE_TOKEN });
    try {
      const tokens = app.get(TokenService);
      await tokens.signIn('u1', 'tok');
      const cache = app.get<ClassCache>(CACHE_TOKEN, { strict: false });
      expect(cache).toBeInstanceOf(ClassCache);
      expect(await cache.has(`token:active:${sha('tok')}`)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('resolves an options-level cacheProvider at bootstrap', async () => {
    const cache = new MemoryCache();
    @Global()
    @Module({ providers: [{ provide: CACHE_TOKEN, useFactory: () => cache }], exports: [CACHE_TOKEN] })
    class CacheModule {}
    const app = await boot(CacheModule, {
      useFactory: () => ({ jwtSecret: 'unit-test-jwt-secret-0123456789abcdef', cacheProvider: CACHE_TOKEN }),
    });
    try {
      await app.get(TokenService).signIn('u1', 'tok');
      expect(await cache.has(`token:active:${sha('tok')}`)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('fails startup when an options-level cacheProvider does not resolve', async () => {
    @Global()
    @Module({})
    class EmptyModule {}
    await expect(
      boot(EmptyModule, {
        useFactory: () => ({ jwtSecret: 'unit-test-jwt-secret-0123456789abcdef', cacheProvider: CACHE_TOKEN }),
      }),
    ).rejects.toThrow(/cacheProvider/);
  });
});

describe('readAccessTokenClaims (N-M2 / N-H1)', () => {
  it('parses rva and zsess next to sub and iat', () => {
    const token = jwt({ sub: 'u1', iat: 1700000000, rva: 1700000000123, zsess: 1 });
    expect(readAccessTokenClaims(token)).toEqual({ sub: 'u1', iat: 1700000000, rva: 1700000000123, sessionTracked: true });
  });

  it('ignores malformed rva and absent zsess', () => {
    expect(readAccessTokenClaims(jwt({ sub: 'u1', rva: 'abc' }))).toEqual({ sub: 'u1' });
    expect(readAccessTokenClaims(jwt({ sub: 'u1', zsess: false }))).toEqual({ sub: 'u1' });
    expect(readAccessTokenClaims(jwt({ sub: 'u1', jti: 'x' }))).toEqual({ sub: 'u1' });
  });
});
