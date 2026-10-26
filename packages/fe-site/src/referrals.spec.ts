import { afterEach, describe, expect, it, vi } from 'vitest';
import { readBrowserReferral, readReferral, referralMetadata, validateReferral, type ReferralPolicy, type ReferralProvider } from './index';

const enabled: ReferralPolicy = { enabledProviders: ['affonso', 'promotekit'] };
const providers = ['affonso', 'promotekit'] as const;
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('referral validation and server metadata', () => {
  it('is disabled by default and enables each provider independently', () => {
    const affonso = { provider: 'affonso', referralId: 'synthetic-123' };
    expect(validateReferral(affonso)).toBeNull();
    expect(referralMetadata(affonso)).toEqual({});
    expect(validateReferral(affonso, { enabledProviders: ['promotekit'] })).toBeNull();
    expect(validateReferral(affonso, enabled)).toEqual(affonso);
  });

  it.each([null, undefined, [], 'synthetic', 123, {}, { provider: 'other', referralId: 'synthetic' }, { provider: 'affonso' }])
    ('rejects malformed or unsupported input: %j', input => {
      expect(validateReferral(input, enabled)).toBeNull();
      expect(referralMetadata(input, enabled)).toEqual({});
    });

  it.each(['', ' synthetic', 'synthetic ', 'synthetic\n', 'synthetic\r', 'synthetic\r\n', 'synthetic\t', 'synthetic\u2028', 'synthetic\u2029', 'synthetic@example.test', 'https://example.test/ref', '../synthetic', '_synthetic', 'synthetic/other', 'synthetic?via=other', '合成', 'x'.repeat(129)])
    ('rejects referral IDs outside the complete allowed format: %j', referralId => {
      expect(validateReferral({ provider: 'affonso', referralId }, enabled)).toBeNull();
      expect(referralMetadata({ provider: 'affonso', referralId }, enabled)).toEqual({});
    });

  it.each(['a', 'Synthetic_123.foo~bar-baz', 'x'.repeat(128)])('accepts allowed identifiers including length boundaries: %s', referralId => {
    expect(validateReferral({ provider: 'promotekit', referralId }, enabled)).toEqual({ provider: 'promotekit', referralId });
  });

  it('ignores inherited fields and accessors without executing their code', () => {
    const getter = vi.fn(() => 'affonso');
    const accessor = Object.defineProperty({ referralId: 'synthetic' }, 'provider', { get: getter });
    expect(validateReferral(accessor, enabled)).toBeNull();
    expect(validateReferral(Object.create({ provider: 'affonso', referralId: 'synthetic' }), enabled)).toBeNull();
    expect(getter).not.toHaveBeenCalled();
  });

  it.each(providers)('maps %s only to its official metadata key and discards other data', provider => {
    const input = {
      provider,
      referralId: 'synthetic-123',
      email: 'synthetic@example.test',
      userId: 'synthetic-user',
      metadata: { email: 'synthetic@example.test', orderId: 'override' },
      affonso_referral: 'unvalidated',
      promotekit_referral: 'unvalidated',
    };
    expect(referralMetadata(input, enabled)).toEqual({ [`${provider}_referral`]: 'synthetic-123' });
    expect(input.metadata.orderId).toBe('override');
  });
});

describe('official referral source reading', () => {
  it.each(providers)('reads %s only when its policy is enabled', provider => {
    const source = { cookieHeader: `${provider}_referral=synthetic`, globals: { [`${provider}_referral`]: 'synthetic' } };
    expect(readReferral(provider, source)).toBeNull();
    expect(readReferral(provider, source, enabled)).toEqual({ provider, referralId: 'synthetic' });
  });

  it.each(providers)('reads the exact official %s cookie or own global value', provider => {
    expect(readReferral(provider, { cookieHeader: `other=x; ${provider}_referral=synthetic%2D123; later=y` }, enabled)).toEqual({ provider, referralId: 'synthetic-123' });
    expect(readReferral(provider, { globals: { [`${provider}_referral`]: 'synthetic-123' } }, enabled)).toEqual({ provider, referralId: 'synthetic-123' });
  });

  it('ignores URL aliases, other providers and cookies with similar names', () => {
    expect(readReferral('affonso', {
      cookieHeader: 'atp=synthetic; via=synthetic; ref=synthetic; xaffonso_referral=synthetic; affonso_referral_extra=synthetic; promotekit_referral=synthetic',
      globals: { promotekit_referral: 'synthetic' },
    }, enabled)).toBeNull();
  });

  it.each([
    'affonso_referral=one; affonso_referral=two',
    'affonso_referral=same; affonso_referral=same',
    'affonso_referral=synthetic; affonso_referral=',
    'affonso_referral=',
    'affonso_referral=%ZZ',
    'affonso_referral=%E0%A4%A',
    'affonso_referral=synthetic%0A',
    'affonso_referral=synthetic%252D123',
    `affonso_referral=${'a'.repeat(513)}`,
    `other=${'x'.repeat(65537)}`,
  ])('rejects duplicate, malformed or oversized cookie input: %.60s', cookieHeader => {
    expect(readReferral('affonso', { cookieHeader, globals: { affonso_referral: 'synthetic' } }, enabled)).toBeNull();
  });

  it('rejects conflicting or malformed global evidence even when the cookie is valid', () => {
    for (const global of ['different', '', 123, null, {}, 'synthetic\n']) {
      expect(readReferral('affonso', { cookieHeader: 'affonso_referral=synthetic', globals: { affonso_referral: global } }, enabled)).toBeNull();
    }
    expect(readReferral('affonso', { cookieHeader: 'affonso_referral=synthetic', globals: { affonso_referral: 'synthetic' } }, enabled))
      .toEqual({ provider: 'affonso', referralId: 'synthetic' });
  });

  it('does not execute or inherit global referral properties', () => {
    const getter = vi.fn(() => 'synthetic');
    const globals = Object.defineProperty({}, 'affonso_referral', { get: getter });
    expect(readReferral('affonso', { globals }, enabled)).toBeNull();
    expect(readReferral('affonso', { globals: Object.create({ affonso_referral: 'synthetic' }) }, enabled)).toBeNull();
    expect(getter).not.toHaveBeenCalled();
  });
});

describe('explicit browser referral reading', () => {
  it('is safe without browser globals and never reads cookies when disabled', () => {
    vi.stubGlobal('window', undefined);
    vi.stubGlobal('document', undefined);
    expect(readBrowserReferral('affonso', enabled)).toBeNull();
    const readCookie = vi.fn(() => 'affonso_referral=synthetic');
    vi.stubGlobal('window', { affonso_referral: 'synthetic' });
    vi.stubGlobal('document', Object.defineProperty({}, 'cookie', { get: readCookie }));
    expect(readBrowserReferral('affonso')).toBeNull();
    expect(readBrowserReferral('affonso', { enabledProviders: ['promotekit'] })).toBeNull();
    expect(readCookie).not.toHaveBeenCalled();
  });

  it.each(providers)('reads %s without cookie writes, DOM mutation, URL lookup or network activity', (provider: ReferralProvider) => {
    const readCookie = vi.fn(() => `${provider}_referral=synthetic`);
    const writeCookie = vi.fn();
    const createElement = vi.fn();
    const fetcher = vi.fn();
    const getLocation = vi.fn(() => ({ search: '?via=untrusted' }));
    const browser = Object.defineProperty({ [`${provider}_referral`]: 'synthetic' }, 'location', { get: getLocation });
    vi.stubGlobal('window', browser);
    vi.stubGlobal('document', Object.defineProperty({ createElement }, 'cookie', { get: readCookie, set: writeCookie }));
    vi.stubGlobal('fetch', fetcher);
    expect(readBrowserReferral(provider, enabled)).toEqual({ provider, referralId: 'synthetic' });
    expect(readCookie).toHaveBeenCalledTimes(1);
    expect(writeCookie).not.toHaveBeenCalled();
    expect(createElement).not.toHaveBeenCalled();
    expect(getLocation).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('tolerates denied cookie access and uses only a valid enabled global', () => {
    vi.stubGlobal('document', Object.defineProperty({}, 'cookie', { get() { throw new Error('Synthetic storage denied'); } }));
    vi.stubGlobal('window', { affonso_referral: 'synthetic' });
    expect(readBrowserReferral('affonso', enabled)).toEqual({ provider: 'affonso', referralId: 'synthetic' });
    vi.stubGlobal('window', { affonso_referral: 'synthetic@example.test' });
    expect(readBrowserReferral('affonso', enabled)).toBeNull();
  });
});
