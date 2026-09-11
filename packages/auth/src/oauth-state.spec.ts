import { describe, expect, it, vi } from 'vitest';
import { OAuthStateService } from './oauth-state';
describe('browser-bound signed state', () => {
  const setup = () => {
    let payload: unknown;
    let nonce = '';
    const response = {
      cookie: vi.fn((_name: string, value: string) => {
        nonce = value;
      }),
      clearCookie: vi.fn(),
    };
    const service = new OAuthStateService({
      cookie: (provider) => ({ name: `state_${provider}`, secure: false, maxAge: 60_000 }),
      sign: (value) => {
        payload = value;
        return 'signed';
      },
      verify: () => payload,
    });
    return {
      service,
      response,
      request: () => ({ headers: { cookie: `state_a=${nonce}` } }),
      setPayload: (value: unknown) => {
        payload = value;
      },
    };
  };
  it('accepts the initiating cookie and clears it before verification', () => {
    const { service, response, request } = setup();
    service.issue(response, 'a');
    service.verify(request(), response, 'a', 'signed');
    expect(response.cookie.mock.calls[0][1]).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(response.clearCookie).toHaveBeenCalledOnce();
  });
  it('rejects malformed cookies, incorrect providers and malformed payloads without leaking parser errors', () => {
    const { service, response, request, setPayload } = setup();
    service.issue(response, 'a');
    expect(() =>
      service.verify({ headers: { cookie: 'state_a=%ZZ' } }, response, 'a', 'signed'),
    ).toThrow('missing');
    setPayload({ purpose: 'oauth_state', provider: 'b', nonce: 3 });
    expect(() => service.verify(request(), response, 'a', 'signed')).toThrow('mismatch');
  });
});
