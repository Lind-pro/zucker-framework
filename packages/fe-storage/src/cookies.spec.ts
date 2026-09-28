import { afterEach, describe, expect, it, vi } from 'vitest';
import { setCookie, getCookie, removeCookie } from './index';

afterEach(() => vi.unstubAllGlobals());
describe('browser cookies', () => {
  it('round trips Unicode, separators and equal signs without header injection', () => {
    setCookie('fixture', '中文; key=value', { path: '/', sameSite: 'Lax' });
    expect(getCookie('fixture')).toBe('中文; key=value');
    removeCookie('fixture', { path: '/' });
    expect(getCookie('fixture')).toBeNull();
  });
  it('serializes explicit policy and deletes with matching scope', () => {
    const target = { cookie: '' }; vi.stubGlobal('document', target);
    setCookie('session', 'a.b.c', { path: '/scope', domain: '.example.test', expires: new Date('2030-01-01T00:00:00Z'), maxAge: 60, sameSite: 'Strict', secure: true });
    expect(target.cookie).toBe('session=a.b.c; Path=/scope; Domain=.example.test; Expires=Tue, 01 Jan 2030 00:00:00 GMT; Max-Age=60; SameSite=Strict; Secure');
    removeCookie('session', { path: '/scope', domain: '.example.test', secure: true });
    expect(target.cookie).toContain('Path=/scope; Domain=.example.test; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; Secure');
  });
  it('matches exact names and tolerates malformed legacy encoding', () => {
    vi.stubGlobal('document', { cookie: 'not_session=other; session=%broken; other=a=b' });
    expect(getCookie('session')).toBe('%broken'); expect(getCookie('other')).toBe('a=b'); expect(getCookie('missing')).toBeNull();
  });
  it('is safe during SSR without document', () => {
    vi.stubGlobal('document', undefined);
    expect(() => setCookie('session', 'token')).not.toThrow();
    expect(getCookie('session')).toBeNull();
    expect(() => removeCookie('session')).not.toThrow();
  });
  it.each([
    () => setCookie('bad;name', 'secret'),
    () => setCookie('session', 'secret', { path: '/;Secure' }),
    () => setCookie('session', 'secret', { domain: 'example.test\r\nother' }),
    () => setCookie('session', 'secret', { expires: new Date(NaN) }),
    () => setCookie('session', 'secret', { maxAge: Infinity }),
  ])('rejects invalid attributes before touching document', call => {
    const target = { cookie: 'unchanged' }; vi.stubGlobal('document', target);
    expect(call).toThrow(TypeError); expect(target.cookie).toBe('unchanged');
  });
});
