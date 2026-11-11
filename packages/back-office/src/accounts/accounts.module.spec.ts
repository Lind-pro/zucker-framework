// @vitest-environment node
import { RequestMethod, type Type } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import {
  ACCOUNTS_MAILER, ACCOUNTS_OPTIONS, ACCOUNTS_PASSWORD_ENCODER, ACCOUNTS_POLICY, AccountApiKeysController, AccountAvatarController,
  AccountDeletionController, AccountGuard, AccountService, AccountSessionCookie, AccountTwoFactorAdminController, AccountTwoFactorController,
  ApiKeyAccountController, BackOfficeAccountsModule, OAuthController, createAccountController, type BackOfficeAccountsOptions,
} from './index';
import { RecordingMailer } from './testing/account-fixture';

const METHODS: Record<number, string> = { [RequestMethod.GET]: 'GET', [RequestMethod.POST]: 'POST', [RequestMethod.DELETE]: 'DELETE', [RequestMethod.PUT]: 'PUT' };
/** `METHOD /prefix/path` of every handler that carries a route decorator (a disabled feature carries none). */
function routes(controller: Type<unknown>): string[] {
  const prefix = Reflect.getMetadata('path', controller) as string;
  const out: string[] = [];
  for (const name of Object.getOwnPropertyNames(controller.prototype)) {
    if (name === 'constructor') continue;
    const handler = controller.prototype[name] as (...args: unknown[]) => unknown;
    const path = Reflect.getMetadata('path', handler) as string | undefined;
    if (path === undefined) continue;
    out.push(`${METHODS[Reflect.getMetadata('method', handler) as number]} /${[prefix, path].filter(part => part && part !== '/').join('/')}`);
  }
  return out.sort();
}
const base: BackOfficeAccountsOptions = { mailer: new RecordingMailer() };
const core = ['POST /authorize/forgot-password', 'POST /authorize/login', 'POST /authorize/logout', 'POST /authorize/password', 'POST /authorize/profile',
  'POST /authorize/refresh', 'POST /authorize/reset-password', 'POST /authorize/verification', 'POST /authorize/verify-email', 'GET /authorize/me',
  'GET /authorize/sessions', 'DELETE /authorize/sessions/:id'];

describe('createAccountController routes', () => {
  it('mounts every route by default', () => {
    expect(routes(createAccountController())).toEqual([...core, 'POST /authorize/register', 'POST /authorize/login/two-factor',
      'POST /authorize/magic-link', 'POST /authorize/magic-link/consume'].sort());
  });

  it('a disabled feature registers no route at all', () => {
    expect(routes(createAccountController({ features: { register: false } }))).not.toContain('POST /authorize/register');
    const noMagic = routes(createAccountController({ features: { magicLink: false } }));
    expect(noMagic).not.toContain('POST /authorize/magic-link');
    expect(noMagic).not.toContain('POST /authorize/magic-link/consume');
    expect(routes(createAccountController({ features: { twoFactor: false } }))).not.toContain('POST /authorize/login/two-factor');
    expect(routes(createAccountController({ features: { register: false, magicLink: false, twoFactor: false } }))).toEqual([...core].sort());
  });

  it('every call builds an independent class (features do not leak between compositions)', () => {
    const a = createAccountController({ features: { register: false } });
    const b = createAccountController();
    expect(a).not.toBe(b);
    expect(routes(b)).toContain('POST /authorize/register');
  });
});

describe('BackOfficeAccountsModule.forRoot', () => {
  const controllers = (options: BackOfficeAccountsOptions) => BackOfficeAccountsModule.forRoot(options).controllers ?? [];

  it('fails at startup: invalid options and a missing mailer', () => {
    expect(() => BackOfficeAccountsModule.forRoot({ ...base, models: { nope: 'x' } as never })).toThrow(/unknown model key/);
    expect(() => BackOfficeAccountsModule.forRoot({})).toThrow(/mailer is required/);
    expect(() => BackOfficeAccountsModule.forRoot({ ...base, verification: { mode: 'code' } })).toThrow(/attempts is required/);
  });

  it('mounts the core and two-factor routes by default, nothing optional', () => {
    const list = controllers(base);
    expect(list).toHaveLength(3);
    expect(list).toEqual(expect.arrayContaining([AccountTwoFactorController, AccountTwoFactorAdminController]));
    for (const optional of [OAuthController, AccountApiKeysController, ApiKeyAccountController, AccountDeletionController, AccountAvatarController])
      expect(list).not.toContain(optional);
  });

  it('twoFactor off: neither the login step nor the enrolment/admin controllers exist', () => {
    const module = BackOfficeAccountsModule.forRoot({ ...base, features: { twoFactor: false } });
    expect(module.controllers).toHaveLength(1);
    expect(routes(module.controllers![0] as Type<unknown>)).not.toContain('POST /authorize/login/two-factor');
  });

  it('enabled features add their controllers; mount:false keeps the services but registers no controller', () => {
    const on = controllers({ ...base, features: { oauth: true, apiKeys: true, deletion: true } });
    expect(on).toEqual(expect.arrayContaining([OAuthController, AccountApiKeysController, ApiKeyAccountController, AccountDeletionController]));
    const unmounted = BackOfficeAccountsModule.forRoot({ ...base, features: { oauth: { mount: false }, apiKeys: { mount: false }, deletion: { mount: false } } });
    expect(unmounted.controllers).toHaveLength(3);
    expect(unmounted.providers).not.toContain(AccountDeletionController);
  });

  it('avatar needs storage and upload', () => {
    expect(() => BackOfficeAccountsModule.forRoot({ ...base, features: { avatar: true } })).toThrow(/avatar needs storage and upload/);
    class Storage { async upload() { return { id: '1' }; } async read() { return { body: Buffer.alloc(0) }; } async delete() { return undefined; } async normalize(b: Buffer) { return b; } }
    class Upload { intercept(_context: unknown, next: { handle(): unknown }) { return next.handle(); } }
    expect(controllers({ ...base, features: { avatar: { storage: Storage as never, upload: Upload as never } } })).toContain(AccountAvatarController);
  });

  it('exports what a consumer root needs for APP_GUARD and product routes', () => {
    const exported = BackOfficeAccountsModule.forRoot(base).exports as unknown[];
    expect(exported).toEqual(expect.arrayContaining([AccountService, AccountGuard, AccountSessionCookie, ACCOUNTS_OPTIONS, ACCOUNTS_MAILER]));
  });

  it('registers a class given for several ports once, and aliases the tokens', () => {
    class Shared { assertConfigured() { /* ok */ } async send() { /* ok */ } async policy() { return {}; } }
    const module = BackOfficeAccountsModule.forRoot({ mailer: Shared as never, policy: Shared as never });
    const providers = module.providers as Array<unknown>;
    expect(providers.filter(provider => provider === Shared)).toHaveLength(1);
    expect(providers).toEqual(expect.arrayContaining([{ provide: ACCOUNTS_MAILER, useExisting: Shared }, { provide: ACCOUNTS_POLICY, useExisting: Shared }]));
  });

  it('a password encoder given as an object is provided as a value', () => {
    const encoder = { encode: async (raw: string) => raw, matches: async () => true };
    const providers = BackOfficeAccountsModule.forRoot({ ...base, passwordEncoder: encoder }).providers as Array<{ provide?: unknown; useValue?: unknown }>;
    expect(providers.find(provider => provider.provide === ACCOUNTS_PASSWORD_ENCODER)?.useValue).toBe(encoder);
  });

  it('access-token verifier classes are provided and resolved in declaration order alongside object verifiers', async () => {
    class First { async verify() { return null; } }
    const second = { verify: async () => null };
    const providers = BackOfficeAccountsModule.forRoot({ ...base, tokens: { additionalAccessVerifiers: [First, second] } }).providers as unknown as Array<Record<string, unknown>>;
    expect(providers).toContain(First);
    const factory = providers.find(provider => typeof provider === 'object' && typeof (provider as { useFactory?: unknown }).useFactory === 'function'
      && (provider as { inject?: unknown[] }).inject?.[0] === First) as { useFactory: (...args: unknown[]) => unknown[] };
    const instance = new First();
    expect(factory.useFactory(instance)).toEqual([instance, second]);
  });

  it('resolves options once: the provided options are the frozen resolved object', () => {
    const provider = (BackOfficeAccountsModule.forRoot({ ...base, locales: { supported: ['zh'] } }).providers as Array<{ provide?: unknown; useValue?: Record<string, unknown> }>)
      .find(entry => entry.provide === ACCOUNTS_OPTIONS);
    expect(Object.isFrozen(provider!.useValue)).toBe(true);
    expect(provider!.useValue).toMatchObject({ locales: { supported: ['zh'], default: 'zh' } });
  });
});
