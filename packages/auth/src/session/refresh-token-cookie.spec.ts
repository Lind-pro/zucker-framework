import { describe, expect, it, vi } from 'vitest';
import { RefreshTokenCookie } from './refresh-token-cookie';

describe('RefreshTokenCookie', () => {
  it('always uses HttpOnly and clears with the same transport attributes', () => {
    const cookie = new RefreshTokenCookie({
      name: 'refresh',
      secure: true,
      maxAge: 60_000,
      path: '/auth',
      domain: 'example.test',
      sameSite: 'strict',
    });
    const response = { cookie: vi.fn(), clearCookie: vi.fn() };
    cookie.issue(response, 'synthetic');
    cookie.clear(response);
    const attributes = {
      httpOnly: true,
      secure: true,
      path: '/auth',
      domain: 'example.test',
      sameSite: 'strict',
    };
    expect(response.cookie).toHaveBeenCalledWith('refresh', 'synthetic', {
      ...attributes,
      maxAge: 60_000,
    });
    expect(response.clearCookie).toHaveBeenCalledWith('refresh', attributes);
  });
  it('handles encoded equals, absent cookies and malformed encoding without throwing', () => {
    const cookie = new RefreshTokenCookie({ name: 'refresh', secure: false, maxAge: 60_000 });
    expect(cookie.read({ headers: { cookie: 'other=x; refresh=token%3Dvalue' } })).toBe(
      'token=value',
    );
    expect(cookie.read({ headers: { cookie: 'refresh=%ZZ' } })).toBeNull();
    expect(cookie.read({ headers: {} })).toBeNull();
    expect(
      () =>
        new RefreshTokenCookie({ name: 'refresh', secure: false, maxAge: 1000, sameSite: 'none' }),
    ).toThrow();
  });
});
