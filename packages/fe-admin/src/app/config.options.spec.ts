import { describe, expect, it } from 'vitest';
import { resolveConfig, type AdminAppConfig } from './config';
import { findPage, localizedText, matchesPath } from './menu';
import { presetToDraft } from '../pages/plans';

const resolve = (config: AdminAppConfig) => resolveConfig(config);
const fail = (config: AdminAppConfig, message: RegExp) => expect(() => resolve(config)).toThrow(message);

describe('resolveConfig: users.typeOptions', () => {
  it('is empty when not configured and keeps order and localized labels when configured', () => {
    expect(resolve({}).usersTypeOptions).toEqual([]);
    const options = [{ value: 'user', label: { 'zh-CN': '用户', 'en-US': 'User' } }, { value: 'admin', label: 'Admin' }];
    expect(resolve({ users: { typeOptions: options } }).usersTypeOptions).toEqual(options);
  });
  it('rejects duplicate, empty and non-string values at configuration time', () => {
    fail({ users: { typeOptions: [{ value: 'a', label: 'A' }, { value: 'a', label: 'B' }] } }, /duplicate identifier: a/);
    fail({ users: { typeOptions: [{ value: '', label: 'A' }] } }, /non-empty string identifier/);
    fail({ users: { typeOptions: [{ value: 5 as never, label: 'A' }] } }, /non-empty string identifier/);
  });
  it('does not alias the caller array (later mutation cannot change the app)', () => {
    const options = [{ value: 'user', label: 'User' }];
    const resolved = resolve({ users: { typeOptions: options } });
    options.push({ value: 'admin', label: 'Admin' });
    expect(resolved.usersTypeOptions).toHaveLength(1);
  });
  it('keeps case-different values apart', () => {
    expect(resolve({ users: { typeOptions: [{ value: 'Admin', label: 'A' }, { value: 'admin', label: 'B' }] } }).usersTypeOptions).toHaveLength(2);
  });
});

describe('resolveConfig: users.passwordReset', () => {
  it('is null unless configured and defaults the method to POST', () => {
    expect(resolve({}).usersPasswordReset).toBeNull();
    expect(resolve({ users: { passwordReset: { path: '/users/:id/reset-password' } } }).usersPasswordReset).toEqual({ path: '/users/:id/reset-password', method: 'POST' });
    expect(resolve({ users: { passwordReset: { path: '/users/:id', method: 'PUT', minLength: 8 } } }).usersPasswordReset).toEqual({ path: '/users/:id', method: 'PUT', minLength: 8 });
    expect(resolve({ users: { passwordReset: { path: '/users/:id', method: 'PATCH', minLength: 1 } } }).usersPasswordReset?.minLength).toBe(1);
  });
  it.each(['/users/reset', '', '/users/id', '/users/:userId'])('rejects a path without :id (%j)', (path) => {
    fail({ users: { passwordReset: { path } } }, /must contain :id/);
  });
  it.each(['DELETE', 'GET', 'put', 'post', '', 'HEAD'])('rejects method %j', (method) => {
    fail({ users: { passwordReset: { path: '/users/:id', method: method as never } } }, /must be POST, PUT or PATCH/);
  });
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '8' as never, null as never])('rejects minLength %j', (minLength) => {
    fail({ users: { passwordReset: { path: '/users/:id', minLength } } }, /minLength must be a positive integer/);
  });
  it('rejects a non-string path', () => {
    fail({ users: { passwordReset: { path: 5 as never } } }, /must contain :id/);
  });
});

describe('resolveConfig: users.twoFactorResetPath and login.forgotPasswordHref', () => {
  it('uses the two-factor reset path only when it names the user', () => {
    expect(resolve({ users: { twoFactorResetPath: '/users/:id/2fa' } }).usersTwoFactorResetPath).toBe('/users/:id/2fa');
    expect(resolve({ users: { twoFactorResetPath: '/users/2fa' } }).usersTwoFactorResetPath).toBeNull();
    expect(resolve({}).usersTwoFactorResetPath).toBeNull();
  });
  it('accepts a site-relative path or an http(s) URL and trims it', () => {
    expect(resolve({}).loginForgotPasswordHref).toBeNull();
    for (const href of ['/en/forgot-password', 'https://site.example.invalid/forgot', 'http://localhost:3000/x'])
      expect(resolve({ login: { forgotPasswordHref: href } }).loginForgotPasswordHref).toBe(href);
    expect(resolve({ login: { forgotPasswordHref: '  /forgot  ' } }).loginForgotPasswordHref).toBe('/forgot');
  });
  it.each(['//evil.example.invalid', '/\\evil.example.invalid', 'javascript:alert(1)', 'data:text/html,x', 'ftp://x.invalid', 'forgot', '', '   ', 'mailto:a@b.invalid'])(
    'rejects an unsafe forgot-password link %j', (forgotPasswordHref) => {
      fail({ login: { forgotPasswordHref } }, /forgotPasswordHref must be a site-relative path or an http\(s\) URL/);
    });
});

describe('resolveConfig: plans.presets', () => {
  const plan = { slug: 'pro', name: 'Pro' };
  it('accepts several presets with localized text and keeps order', () => {
    const presets = [{ key: 'a', label: 'A', plan }, { key: 'b', label: { 'zh-CN': '乙' }, description: { 'en-US': 'B' }, plan }];
    expect(resolve({ plans: { presets } }).planPresets).toEqual(presets);
    expect(resolve({}).planPresets).toEqual([]);
  });
  it('rejects duplicate and empty keys', () => {
    fail({ plans: { presets: [{ key: 'a', label: 'A', plan }, { key: 'a', label: 'B', plan }] } }, /duplicate identifier: a/);
    fail({ plans: { presets: [{ key: '', label: 'A', plan }] } }, /non-empty string identifier/);
    fail({ plans: { presets: [{ label: 'A', plan } as never] } }, /non-empty string identifier/);
  });
});

describe('presetToDraft', () => {
  it('turns numeric amounts into decimal strings and keeps provider refs, term days and credits', () => {
    const draft = presetToDraft({ slug: 'pro', name: 'Pro', status: true,
      prices: [{ interval: 'month', currency: 'CNY', amount: 299 }, { interval: 'one_time', currency: 'USD', amount: '19.90', termDays: 30, providerRefs: { stripe: 'price_x' }, credits: 5 }] });
    expect(draft.status).toBe(true);
    expect(draft.prices.map(price => price.amount)).toEqual(['299', '19.90']);
    expect(JSON.stringify(draft.prices[1])).toContain('price_x');
    expect(JSON.stringify(draft.prices[1])).toContain('30');
  });
  it('works without prices and never writes back into the preset', () => {
    const values = Object.freeze({ slug: 'free', name: 'Free', prices: Object.freeze([]) });
    const draft = presetToDraft(values);
    expect(draft.prices).toEqual([]);
    expect(draft.status).toBe(false);
    expect(presetToDraft({}).prices).toEqual([]);
  });
});

describe('localizedText', () => {
  it('prefers the exact locale, then zh-CN, then the first value, then empty', () => {
    expect(localizedText('plain', 'en-US')).toBe('plain');
    expect(localizedText({ 'zh-CN': '中', 'en-US': 'en' }, 'en-US')).toBe('en');
    expect(localizedText({ 'zh-CN': '中', 'en-US': 'en' }, 'fr-FR')).toBe('中');
    expect(localizedText({ 'en-US': 'en' }, 'fr-FR')).toBe('en');
    expect(localizedText({}, 'en-US')).toBe('');
    expect(localizedText(undefined, 'en-US')).toBe('');
  });
});

describe('matchesPath', () => {
  it('matches exact and nested paths without prefix collisions', () => {
    expect(matchesPath('/users', '/users')).toBe(true);
    expect(matchesPath('/users/1', '/users')).toBe(true);
    expect(matchesPath('/users2', '/users')).toBe(false);
    expect(matchesPath('/user', '/users')).toBe(false);
    expect(matchesPath('/', '/users')).toBe(false);
  });
  it('handles parameters in the middle, at the end and several times', () => {
    expect(matchesPath('/a/1/b', '/a/:id/b')).toBe(true);
    expect(matchesPath('/a/1/b/c', '/a/:id/b')).toBe(true);
    expect(matchesPath('/a/1/c', '/a/:id/b')).toBe(false);
    expect(matchesPath('/a//b', '/a/:id/b')).toBe(false);
    expect(matchesPath('/a/1/b', '/a/:id/:other')).toBe(true);
    expect(matchesPath('/a/1', '/a/:id/:other')).toBe(false);
    expect(matchesPath('/a', '/a/:id')).toBe(false);
  });
  it('treats the path as text, never as a pattern', () => {
    expect(matchesPath('/a.b', '/a.b')).toBe(true);
    expect(matchesPath('/axb', '/a.b')).toBe(false);
    expect(matchesPath('/a/(x)', '/a/(x)')).toBe(true);
    expect(matchesPath('/a/1', '/a/*')).toBe(false);
  });
  it('findPage picks the longest matching path and returns undefined without a match', () => {
    const pages = [{ key: 'r', path: '/reports' }, { key: 'd', path: '/reports/:id' }, { key: 'e', path: '/reports/:id/edit' }] as never[];
    expect(findPage(pages, '/reports')?.key).toBe('r');
    expect(findPage(pages, '/reports/1')?.key).toBe('d');
    expect(findPage(pages, '/reports/1/edit')?.key).toBe('e');
    expect(findPage(pages, '/reports/1/other')?.key).toBe('d');
    expect(findPage(pages, '/other')).toBeUndefined();
  });
});

describe('resolveConfig: login.identifier', () => {
  it('defaults to username, keeps a valid option and rejects an unknown one', () => {
    expect(resolve({}).loginIdentifier).toBe('username');
    expect(resolve({ login: { identifier: 'email' } }).loginIdentifier).toBe('email');
    expect(resolve({ login: { identifier: 'username-or-email' } }).loginIdentifier).toBe('username-or-email');
    fail({ login: { identifier: 'phone' as never } }, /Unknown login identifier/);
  });
});
