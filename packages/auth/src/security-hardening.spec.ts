import { afterEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import { ZuckerAuthModule, resolveJwtSecret } from './auth.module';
import { AUTHENTICATION_MANAGER, AuthorizationController } from './controllers/authorization.controller';
import { isAccessTokenPayload, JwtStrategy } from './strategies/jwt.strategy';
import { TwoFactorGuard } from './guards/two-factor.guard';
import { TwoFactorService } from './two-factor/two-factor.service';
import { TotpValidator } from './two-factor/totp-validator';
import { DataPermissionGuard } from './guards/data-permission.guard';
import { DATA_PERMISSION_KEY, TWO_FACTOR_KEY } from './decorators/constants';
import { TokenService } from './services/token.service';
import { UserTokenController, tokenIdOf } from './controllers/user-token.controller';
import { BcryptEncoder } from './password/bcrypt-encoder';

const env = process.env.NODE_ENV;
afterEach(() => { process.env.NODE_ENV = env; delete process.env.JWT_SECRET; });

describe('JWT secret resolution (M1)', () => {
  it('only allows the dev secret for explicit development/test', () => {
    delete process.env.NODE_ENV;
    expect(() => resolveJwtSecret({})).toThrow(/jwtSecret is required/);
    process.env.NODE_ENV = 'preview';
    expect(() => resolveJwtSecret({})).toThrow(/jwtSecret is required/);
    expect(() => resolveJwtSecret({ jwtSecret: 'short' })).toThrow(/at least 32/);
    process.env.JWT_SECRET = 'x'.repeat(32);
    expect(resolveJwtSecret({})).toBe('x'.repeat(32));
    process.env.NODE_ENV = 'test';
    delete process.env.JWT_SECRET;
    expect(resolveJwtSecret({})).toBe('__zucker_dev_only_secret__');
  });
});

describe('Default authentication manager (H4/L2)', () => {
  async function manager(user: Record<string, unknown> | null) {
    const provider = (ZuckerAuthModule.forRoot({ jwtSecret: 'x'.repeat(32) }).providers as Array<{ provide?: unknown; useFactory?: (...a: unknown[]) => unknown }>)
      .find((p) => p.provide === AUTHENTICATION_MANAGER)!;
    return provider.useFactory!({ findByUsername: async () => user }) as { authenticate(u: string, p: string): Promise<unknown> };
  }
  it('rejects disabled users even with the right password and strips the hash', async () => {
    const hash = await new BcryptEncoder().encode('pw');
    expect(await (await manager({ id: 'u', username: 'a', password: hash, status: false })).authenticate('a', 'pw')).toBeNull();
    const ok = await (await manager({ id: 'u', username: 'a', password: hash, status: true })).authenticate('a', 'pw') as Record<string, unknown>;
    expect(ok).toMatchObject({ id: 'u' });
    expect(ok.password).toBeUndefined();
    expect(await (await manager(null)).authenticate('a', 'pw')).toBeNull();
  });
});

describe('Access-token type binding (M4)', () => {
  it('rejects refresh/state tokens and payloads without sub', () => {
    expect(isAccessTokenPayload({ sub: 'u', username: 'a' })).toBe(true);
    expect(isAccessTokenPayload({ sub: 'u', typ: 'access' })).toBe(true);
    expect(isAccessTokenPayload({ sub: 'u', typ: 'refresh' })).toBe(false);
    expect(isAccessTokenPayload({ purpose: 'oauth_state', nonce: 'n' })).toBe(false);
    expect(isAccessTokenPayload({ username: 'a' })).toBe(false);
    expect(() => new JwtStrategy('x'.repeat(32)).validate({ sub: 'u', username: 'a', typ: 'refresh' })).toThrow();
  });
});

describe('Login events carry no password (M5)', () => {
  it('strips credentials from before/success/failed events and issues typed, unique tokens', async () => {
    const published: Array<[string, Record<string, unknown>]> = [];
    const bus = { publish: async (topic: string, payload: unknown) => { published.push([topic, payload as Record<string, unknown>]); } };
    const tokens = new TokenService(undefined, { sign: (p: unknown) => JSON.stringify(p) } as never);
    const controller = new AuthorizationController(tokens, { authenticate: async () => ({ id: 'u', username: 'a' }) as never }, undefined, bus);
    const first = await controller.login({ username: 'a', password: 'secret-pw', extra: 1 });
    const second = await controller.login({ username: 'a', password: 'secret-pw' });
    expect(JSON.parse(first.token)).toMatchObject({ sub: 'u', typ: 'access' });
    expect(first.token).not.toBe(second.token);
    for (const [topic, payload] of published) {
      if (topic.includes('decode')) continue;
      expect(JSON.stringify(payload)).not.toContain('secret-pw');
    }
  });
});

function http(request: Record<string, unknown>, meta: Record<string, unknown> = {}): ExecutionContext {
  const handler = () => {};
  for (const [key, value] of Object.entries(meta)) Reflect.defineMetadata(key, value, handler);
  return { switchToHttp: () => ({ getRequest: () => request }), getHandler: () => handler, getClass: () => class {} } as unknown as ExecutionContext;
}

describe('TwoFactorGuard / TotpValidator (M2)', () => {
  const meta = { [TWO_FACTOR_KEY]: { operation: 'transfer', provider: 'totp' } };
  function setup() {
    const totp = new TotpValidator({ secretResolver: async () => 'JBSWY3DPEHPK3PXP', maxAttempts: 3 });
    const service = new TwoFactorService([totp]);
    return { totp, guard: new TwoFactorGuard(new Reflector(), service) };
  }
  it('fails closed without a user and ignores query-string codes', async () => {
    const { guard } = setup();
    await expect(guard.canActivate(http({ headers: {} }, meta))).rejects.toThrow();
    await expect(guard.canActivate(http({ user: { id: 'u' }, headers: {}, query: { verifyCode: '123456' } }, meta)))
      .rejects.toThrow('validation.need_two_factor_verify');
  });
  it('locks out after repeated failures and rejects replayed codes', async () => {
    const { totp } = setup();
    const code = (totp as unknown as { generateToken(s: string, c: number): string })
      .generateToken('JBSWY3DPEHPK3PXP', Math.floor(Date.now() / 30000));
    const validator = totp.createTwoFactorValidator('u', 'op', 's1');
    expect(await validator.verify(code, 60_000)).toBe(true);
    // Same code from another session: replay.
    expect(await totp.createTwoFactorValidator('u', 'op', 's2').verify(code, 60_000)).toBe(false);
    // Session-scoped validation: s2 is not validated by s1's success.
    expect(await totp.createTwoFactorValidator('u', 'op', 's2').expired()).toBe(true);
    expect(await validator.expired()).toBe(false);
    for (let i = 0; i < 3; i++) await totp.createTwoFactorValidator('v', 'op').verify('000000', 1000);
    const fresh = (totp as unknown as { generateToken(s: string, c: number): string })
      .generateToken('JBSWY3DPEHPK3PXP', Math.floor(Date.now() / 30000) + 1);
    expect(await totp.createTwoFactorValidator('v', 'op').verify(fresh, 1000)).toBe(false);
  });
});

describe('DataPermissionGuard (M3)', () => {
  const auth = { getUser: () => ({ id: 'u', username: 'a' }), getPermissions: () => [{ id: 'orders', dataAccesses: [{ action: 'query', type: { id: 'custom' } }] }] };
  it('denies when no handler supports a configured restriction', async () => {
    const guard = new DataPermissionGuard(new Reflector(), []);
    const ctx = http({ auth, method: 'GET', path: '/orders' }, { [DATA_PERMISSION_KEY]: { dataType: 'orders' } });
    await expect(guard.canActivate(ctx)).resolves.toBe(false);
  });
  it('honours class-level @DataPermission', async () => {
    const guard = new DataPermissionGuard(new Reflector(), []);
    class Ctl {}
    Reflect.defineMetadata(DATA_PERMISSION_KEY, { dataType: 'orders' }, Ctl);
    const ctx = { switchToHttp: () => ({ getRequest: () => ({ auth, method: 'GET', path: '/orders' }) }), getHandler: () => () => {}, getClass: () => Ctl } as unknown as ExecutionContext;
    await expect(guard.canActivate(ctx)).resolves.toBe(false);
  });
});

describe('DataPermissionGuard empty-permission warning (N-L3)', () => {
  const noPermissions = { getUser: () => ({ id: 'u', username: 'a' }), getPermissions: () => [] };
  function routeContext(handlerName: string, controllerName: string): ExecutionContext {
    const handler = { [handlerName]: () => {} }[handlerName];
    Reflect.defineMetadata(DATA_PERMISSION_KEY, { dataType: 'orders' }, handler);
    const controller = { [controllerName]: class {} }[controllerName];
    const request = { auth: noPermissions, method: 'GET', path: '/orders' };
    return { switchToHttp: () => ({ getRequest: () => request }), getHandler: () => handler, getClass: () => controller } as unknown as ExecutionContext;
  }

  it('warns once per route when the Authentication carries no permissions, and still allows', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const guard = new DataPermissionGuard(new Reflector(), []);
      const first = routeContext('list', 'OrdersController');
      await expect(guard.canActivate(first)).resolves.toBe(true);
      await expect(guard.canActivate(first)).resolves.toBe(true);
      await expect(guard.canActivate(routeContext('list', 'OrdersController'))).resolves.toBe(true);
      const emptyWarnings = () => warn.mock.calls.filter(([message]) => String(message).includes('carries no permissions'));
      expect(emptyWarnings()).toHaveLength(1);
      expect(String(emptyWarnings()[0][0])).toContain('OrdersController.list');
      // A different route warns separately.
      await guard.canActivate(routeContext('detail', 'OrdersController'));
      expect(emptyWarnings()).toHaveLength(2);
    } finally {
      warn.mockRestore();
    }
  });

  it('does not warn when the Authentication carries permissions', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const guard = new DataPermissionGuard(new Reflector(), []);
      const ctx = routeContext('list', 'OrdersController');
      (ctx.switchToHttp().getRequest() as { auth: unknown }).auth = {
        getUser: () => ({ id: 'u', username: 'a' }),
        getPermissions: () => [{ id: 'orders', dataAccesses: [] }],
      };
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      expect(warn.mock.calls.filter(([message]) => String(message).includes('carries no permissions'))).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('UserTokenController (M6)', () => {
  it('never returns raw tokens and addresses sessions by id', async () => {
    const tokens = new TokenService();
    await tokens.signIn('u1', 'raw-secret-token');
    const controller = new UserTokenController(tokens);
    const list = await controller.allLoggedUser();
    expect(JSON.stringify(list)).not.toContain('raw-secret-token');
    expect(list[0].tokenId).toBe(tokenIdOf('raw-secret-token'));
    await controller.signOutByToken(list[0].tokenId);
    expect(await tokens.isBlacklisted('raw-secret-token')).toBe(true);
    await expect(controller.changeUserState('u1', 'lock')).resolves.toBeUndefined();
    await expect(controller.changeUserState('u1', 'bogus')).rejects.toMatchObject({ status: 400 });
  });
});
