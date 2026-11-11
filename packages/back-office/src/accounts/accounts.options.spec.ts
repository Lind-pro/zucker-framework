// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { BcryptEncoder, ScryptEncoder } from '@zucker-framework/auth';
import {
  DEFAULT_ACCOUNTS_MODELS, DEFAULT_ACCOUNTS_TABLES, accountOrigins, accountTable, cookieSecure, resolveAccountsOptions, type BackOfficeAccountsOptions,
} from './index';

const bad = (input: unknown, message: RegExp) => expect(() => resolveAccountsOptions(input as BackOfficeAccountsOptions)).toThrowError(message);
const attempts = { remainingLock: async () => 0, recordFailure: async () => 0, clearFailures: async () => undefined };

describe('resolveAccountsOptions defaults', () => {
  it('applies documented defaults, prefixes every message, and freezes the result', () => {
    const resolved = resolveAccountsOptions();
    expect(resolved.models).toEqual(DEFAULT_ACCOUNTS_MODELS);
    expect(resolved.tables).toEqual(DEFAULT_ACCOUNTS_TABLES);
    expect(resolved.tokens).toMatchObject({ accessTtlSeconds: 900, refreshTtlSeconds: 30 * 86400, accessAudience: 'zucker:access', refreshAudience: 'zucker:refresh' });
    expect(resolved.tickets).toEqual({ mailSeconds: 1800, magicLinkSeconds: 900, twoFactorSeconds: 300 });
    expect(resolved.verification).toMatchObject({ mode: 'ticket', codeExpirySeconds: 900, resendSeconds: 60, signInOnVerify: false, fields: { subject: 'email', purpose: 'purpose' } });
    expect(resolved.cookie).toMatchObject({ name: 'zucker-session', path: '/', sameSite: 'lax', secure: true });
    expect(resolved.locales).toEqual({ supported: ['en', 'zh'], default: 'en' });
    expect(resolved.origins).toEqual([]);
    expect(resolved.features).toMatchObject({ register: true, magicLink: true, deletion: null, avatar: null, apiKeys: null, oauth: null });
    expect(resolved.features.twoFactor).toMatchObject({ mount: true });
    for (const frozen of [resolved, resolved.models, resolved.tables, resolved.tokens, resolved.features, resolved.cookie]) expect(Object.isFrozen(frozen)).toBe(true);
    bad('x' as never, /^TypeError: \[back-office\/accounts\] |\[back-office\/accounts\] /);
  });

  it('every disabled-by-default feature stays off until asked for', () => {
    const on = resolveAccountsOptions({ features: { deletion: true, avatar: true, apiKeys: true, oauth: true, twoFactor: false, register: false, magicLink: false } });
    expect(on.features).toMatchObject({ register: false, magicLink: false, twoFactor: null });
    expect(on.features.deletion).toMatchObject({ mount: true });
    expect(on.features.apiKeys).toMatchObject({ scopes: ['account:read'], keyPrefix: 'zk_api_', rateLimit: 60, expiryDays: [7, 30, 90, 365] });
    expect(on.features.oauth).toMatchObject({ googleOneTap: true, googleRedirect: true, github: true, mount: true,
      returnPaths: { defaultPath: '/dashboard', linkPath: '/account' }, browserCookie: { name: 'zucker-oauth-browser', path: '/api/authorize/oauth' } });
    expect(on.features.oauth!.callbackPath('github')).toBe('/api/authorize/oauth/github/callback');
    expect(on.features.oauth!.completionPath('en')).toBe('/en/oauth/callback');
  });
});

describe('models and tables', () => {
  it('rejects unknown keys, non-identifiers and non-objects', () => {
    bad({ models: { session: 'x' } }, /unknown model key "session"/);
    bad({ models: { users: 'bad name' } }, /model "users" must be an identifier/);
    bad({ models: { users: 'a;b' } }, /must be an identifier/);
    bad({ models: [] }, /models must be an object/);
    bad({ tables: { sessions: 'x' } }, /unknown table key "sessions"/);
    bad({ tables: { users: 'x"y' } }, /table "users" must be an identifier/);
    bad({ tables: [] }, /tables must be an object/);
    bad({ tables: null }, /./);
  });

  it('only the optional link tables may be null', () => {
    bad({ tables: { users: null } }, /table "users" is required/);
    bad({ tables: { accountSessions: null } }, /table "accountSessions" is required/);
    const resolved = resolveAccountsOptions({ tables: { userPermissions: null, userAcquisition: null, userTokens: 'legacy_tokens' } });
    expect(resolved.tables).toMatchObject({ userPermissions: null, userAcquisition: null, userTokens: 'legacy_tokens' });
    expect(() => accountTable(resolved, 'userPermissions')).toThrow(/not configured/);
  });

  it('quotes anything but a plain lower-case non-keyword table name', () => {
    const resolved = resolveAccountsOptions({ tables: { users: 'User', roles: 'role', userRoles: 'user', fileAssets: 'FileAsset', accountSessions: 'auth_sessions' } });
    expect(accountTable(resolved, 'users')).toBe('"User"'); // mixed case keeps its case
    expect(accountTable(resolved, 'userRoles')).toBe('"user"'); // reserved word
    expect(accountTable(resolved, 'roles')).toBe('role');
    expect(accountTable(resolved, 'accountSessions')).toBe('auth_sessions');
  });

  it('an overridden model name never leaks other defaults', () => {
    const resolved = resolveAccountsOptions({ models: { accountSessions: 'auth_sessions', emailVerifications: 'mail_codes' } });
    expect(resolved.models).toEqual({ ...DEFAULT_ACCOUNTS_MODELS, accountSessions: 'auth_sessions', emailVerifications: 'mail_codes' });
  });
});

describe('tokens', () => {
  it('requires positive integer lifetimes and distinct, printable audiences', () => {
    bad({ tokens: { accessTtlSeconds: 0 } }, /accessTtlSeconds must be a positive integer/);
    bad({ tokens: { accessTtlSeconds: 1.5 } }, /positive integer/);
    bad({ tokens: { refreshTtlSeconds: '1' } }, /positive integer/);
    bad({ tokens: { accessAudience: 'a', refreshAudience: 'a' } }, /audiences must differ/);
    bad({ tokens: { accessAudience: 'has space' } }, /accessAudience is invalid/);
    bad({ tokens: { extraClaims: 'x' } }, /extraClaims must be a function/);
  });

  it('strips reserved claims from extraClaims and keeps product claims', () => {
    const resolved = resolveAccountsOptions({ tokens: { extraClaims: () => ({ sub: 'x', sid: 'x', tokenUse: 'x', aud: 'x', exp: 1, iat: 1, nbf: 1, jti: 'x', iss: 'x', username: 'u', role: 'r' }) } });
    expect(resolved.tokens.extraClaims({} as never)).toEqual({ username: 'u', role: 'r' });
    expect(resolveAccountsOptions().tokens.extraClaims({ username: 'bob' } as never)).toEqual({ username: 'bob' });
  });

  it('additional verifiers must be classes or objects with verify()', () => {
    bad({ tokens: { additionalAccessVerifiers: 'x' } }, /additionalAccessVerifiers must be verifier classes/);
    bad({ tokens: { additionalAccessVerifiers: [{}] } }, /additionalAccessVerifiers must be verifier classes/);
    bad({ tokens: { additionalAccessVerifiers: [null] } }, /additionalAccessVerifiers must be verifier classes/);
    class Legacy { async verify() { return null; } }
    const resolved = resolveAccountsOptions({ tokens: { additionalAccessVerifiers: [Legacy, { verify: async () => null }] } });
    expect(resolved.tokens.additionalAccessVerifiers).toHaveLength(2);
    expect(Object.isFrozen(resolved.tokens.additionalAccessVerifiers)).toBe(true);
  });

  it('ticket lifetimes are validated', () => {
    bad({ tickets: { mailSeconds: -1 } }, /tickets\.mailSeconds/);
    bad({ tickets: { twoFactorSeconds: 0 } }, /tickets\.twoFactorSeconds/);
  });
});

describe('verification', () => {
  it('code mode requires an attempt store; ticket mode does not', () => {
    bad({ verification: { mode: 'code' } }, /verification\.attempts is required in code mode/);
    bad({ verification: { mode: 'sms' } }, /verification\.mode must be "ticket" or "code"/);
    expect(() => resolveAccountsOptions({ verification: { mode: 'ticket' } })).not.toThrow();
    const resolved = resolveAccountsOptions({ verification: { mode: 'code', attempts, codeExpirySeconds: 600, resendSeconds: 30, signInOnVerify: true,
      fields: { subject: 'email', purpose: 'type' } } });
    expect(resolved.verification).toMatchObject({ mode: 'code', codeExpirySeconds: 600, resendSeconds: 30, signInOnVerify: true, fields: { purpose: 'type' } });
  });

  it('validates timing and the field names of the code model', () => {
    bad({ verification: { mode: 'code', attempts, codeExpirySeconds: 0 } }, /codeExpirySeconds/);
    bad({ verification: { mode: 'code', attempts, resendSeconds: 0.5 } }, /resendSeconds/);
    bad({ verification: { mode: 'code', attempts, fields: { subject: 'bad field' } } }, /fields\.subject is invalid/);
    bad({ verification: { mode: 'code', attempts, fields: { purpose: 'a;b' } } }, /fields\.purpose is invalid/);
  });
});

describe('password encoder', () => {
  it('keeps the encoder instance for the host to use', () => {
    const scrypt = new ScryptEncoder();
    expect(resolveAccountsOptions({ passwordEncoder: scrypt }).passwordEncoder).toBe(scrypt);
    expect(resolveAccountsOptions({ passwordEncoder: BcryptEncoder }).passwordEncoder).toBe(BcryptEncoder);
    expect(resolveAccountsOptions().passwordEncoder).toBeUndefined();
  });
});

describe('cookie, origins and locales', () => {
  it('validates cookie attributes', () => {
    bad({ cookie: { sameSite: 'weird' } }, /cookie\.sameSite must be lax, strict or none/);
    bad({ cookie: { sameSite: 'none', secure: false } }, /requires a secure cookie/);
    bad({ cookie: { secure: 'yes' } }, /cookie\.secure must be a boolean or function/);
    bad({ cookie: { name: 'bad name' } }, /cookie\.name is invalid/);
    bad({ cookie: { path: 'relative' } }, /cookie\.path is invalid/);
    bad({ cookie: { domain: 'bad domain' } }, /cookie\.domain is invalid/);
    const resolved = resolveAccountsOptions({ cookie: { name: 'cc_refresh', path: '/api/authorize', secure: () => false } });
    expect(resolved.cookie).toMatchObject({ name: 'cc_refresh', path: '/api/authorize' });
    expect('domain' in resolved.cookie).toBe(false); // host-only cookie
    expect(cookieSecure(resolved)).toBe(false);
    expect(cookieSecure(resolveAccountsOptions())).toBe(true);
  });

  it('origins are exact http(s) origins, or a function read on use', () => {
    bad({ origins: ['https://app.example.invalid/path'] }, /origins must be a list/);
    bad({ origins: ['ftp://x.example'] }, /origins must be a list/);
    bad({ origins: ['*'] }, /origins must be a list/);
    expect([...accountOrigins(resolveAccountsOptions({ origins: ['https://a.example.invalid', 'https://a.example.invalid'] }))]).toEqual(['https://a.example.invalid']);
    let current = ['https://one.example.invalid'];
    const dynamic = resolveAccountsOptions({ origins: () => current });
    expect([...accountOrigins(dynamic)]).toEqual(['https://one.example.invalid']);
    current = ['https://two.example.invalid'];
    expect([...accountOrigins(dynamic)]).toEqual(['https://two.example.invalid']);
  });

  it('locales: a default must be supported; an empty set is refused', () => {
    bad({ locales: { supported: [] } }, /locales\.supported must not be empty/);
    bad({ locales: { supported: ['EN'] } }, /locales\.supported must be a list/);
    bad({ locales: { supported: ['zh'], default: 'en' } }, /locales\.default must be one of locales\.supported/);
    expect(resolveAccountsOptions({ locales: { supported: ['zh'] } }).locales).toEqual({ supported: ['zh'], default: 'zh' });
    expect(resolveAccountsOptions({ locales: { supported: ['en', 'zh-CN'], default: 'zh-CN' } }).locales.default).toBe('zh-CN');
  });
});

describe('product sign-in methods', () => {
  it('rejects reserved and malformed names and methods without emailProof', () => {
    for (const name of ['password', 'oauth', 'magic-link']) bad({ signInMethods: { [name]: { emailProof: true } } }, /invalid or reserved/);
    for (const name of ['Login', '1code', 'has space', 'x'.repeat(33), '']) bad({ signInMethods: { [name]: { emailProof: true } } }, /invalid or reserved/);
    bad({ signInMethods: { 'login-code': {} } }, /needs emailProof/);
    bad({ signInMethods: { 'login-code': { emailProof: 'yes' } } }, /needs emailProof/);
    bad({ signInMethods: { 'login-code': null } }, /needs emailProof/);
    const resolved = resolveAccountsOptions({ signInMethods: { 'login-code': { emailProof: true }, sso: { emailProof: false } } });
    expect(resolved.signInMethods).toEqual({ 'login-code': { emailProof: true }, sso: { emailProof: false } });
    expect(Object.isFrozen(resolved.signInMethods)).toBe(true);
  });
});

describe('feature options', () => {
  it('rejects non-boolean, non-object feature values and a non-boolean mount', () => {
    bad({ features: { deletion: 'yes' } }, /features must be booleans or option objects/);
    bad({ features: { deletion: [] } }, /features must be booleans or option objects/);
    bad({ features: { deletion: { mount: 'no' } } }, /mount must be a boolean/);
    expect(resolveAccountsOptions({ features: { deletion: { mount: false } } }).features.deletion).toMatchObject({ mount: false });
  });

  it('api key options: scopes, defaults, expiry bounds and prefix', () => {
    bad({ features: { apiKeys: { scopes: ['Bad Scope'] } } }, /scopes must be a list/);
    bad({ features: { apiKeys: { scopes: ['a:read'], defaultScopes: ['b:read'] } } }, /defaultScopes must be allowed scopes/);
    bad({ features: { apiKeys: { expiryDays: [0] } } }, /expiryDays must be 1–3650/);
    bad({ features: { apiKeys: { expiryDays: [4000] } } }, /expiryDays must be 1–3650/);
    bad({ features: { apiKeys: { keyPrefix: 'UP' } } }, /keyPrefix is invalid/);
    bad({ features: { apiKeys: { rateLimit: 0 } } }, /rateLimit must be a positive integer/);
    const resolved = resolveAccountsOptions({ features: { apiKeys: { scopes: ['a:read', 'a:write'], defaultScopes: ['a:read'], keyPrefix: 'pk_' } } });
    expect(resolved.features.apiKeys).toMatchObject({ scopes: ['a:read', 'a:write'], defaultScopes: ['a:read'], keyPrefix: 'pk_' });
  });

  it('oauth return paths must be local absolute paths', () => {
    for (const path of ['https://evil.example', '//evil.example', 'relative', '/a b', '/a\\b']) {
      bad({ features: { oauth: { returnPaths: { defaultPath: path } } } }, /returnPaths entries must be local absolute paths/);
    }
    bad({ features: { oauth: { returnPaths: { exact: ['//x'] } } } }, /local absolute paths/);
    bad({ features: { oauth: { returnPaths: { prefixes: ['x/'] } } } }, /local absolute paths/);
    expect(() => resolveAccountsOptions({ features: { oauth: { returnPaths: { defaultPath: '/home', exact: ['/home'], prefixes: ['/app/'] } } } })).not.toThrow();
  });
});
