import { describe, expect, it } from 'vitest';
import { assertAllowedOutboundUrl, OutboundUrlRejectedError } from './outbound-url-policy';

describe('assertAllowedOutboundUrl', () => {
  const policy = { allowedHosts: ['hooks.example.com'] } as const;

  it('accepts an exact allowlisted HTTPS host', () => {
    expect(assertAllowedOutboundUrl('https://hooks.example.com/events', policy).href).toBe(
      'https://hooks.example.com/events',
    );
  });

  it.each([
    ['http://hooks.example.com/events', 'protocol-not-allowed'],
    ['https://user:secret@hooks.example.com/events', 'credentials-not-allowed'],
    ['https://sub.hooks.example.com/events', 'host-not-allowed'],
    ['https://localhost/events', 'local-host-not-allowed'],
    ['https://127.0.0.1/events', 'ip-literal-not-allowed'],
    ['https://hooks.example.com:8443/events', 'port-not-allowed'],
  ])('rejects %s', (input, reason) => {
    expect(() => assertAllowedOutboundUrl(input, policy)).toThrowError(
      expect.objectContaining<Partial<OutboundUrlRejectedError>>({ reason }),
    );
  });

  it('denies all hosts when the operator has not configured an allowlist', () => {
    expect(() =>
      assertAllowedOutboundUrl('https://hooks.example.com/events', {
        allowedHosts: [],
      }),
    ).toThrowError(
      expect.objectContaining<Partial<OutboundUrlRejectedError>>({
        reason: 'host-not-allowed',
      }),
    );
  });
});
