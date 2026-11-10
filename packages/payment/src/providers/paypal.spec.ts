import { describe, expect, it, vi } from 'vitest';
import { PayPalPaymentTransport } from './paypal';

const signatureHeaders = {
  'paypal-transmission-id': 'synthetic-transmission',
  'paypal-transmission-time': '2026-09-10T00:00:00Z',
  'paypal-cert-url': 'https://api.sandbox.paypal.com/certificates/synthetic',
  'paypal-auth-algo': 'SHA256withRSA',
  'paypal-transmission-sig': 'synthetic-signature',
};
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

describe('PayPal payment transport', () => {
  it('verifies all signature fields with the configured sandbox credentials and event', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json({ access_token: 'synthetic-access' }))
      .mockResolvedValueOnce(json({ verification_status: 'SUCCESS' }));
    const transport = new PayPalPaymentTransport({
      clientId: 'client',
      clientSecret: 'secret',
      mode: 'sandbox',
      fetcher,
    });
    const event = { id: 'event', event_type: 'PAYMENT.CAPTURE.COMPLETED' };
    expect(
      await transport.verifyWebhookSignature(JSON.stringify(event), signatureHeaders, 'webhook'),
    ).toBe(true);
    expect(fetcher.mock.calls[0]).toEqual([
      'https://api.sandbox.paypal.com/v1/oauth2/token',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${Buffer.from('client:secret').toString('base64')}`,
        },
        body: 'grant_type=client_credentials',
        signal: expect.any(AbortSignal),
      },
    ]);
    const [url, request] = fetcher.mock.calls[1];
    expect(request.signal).toBeInstanceOf(AbortSignal);
    expect(url).toBe('https://api.sandbox.paypal.com/v1/notifications/verify-webhook-signature');
    expect(request.headers.Authorization).toBe('Bearer synthetic-access');
    expect(JSON.parse(request.body)).toEqual({
      auth_algo: signatureHeaders['paypal-auth-algo'],
      cert_url: signatureHeaders['paypal-cert-url'],
      transmission_id: signatureHeaders['paypal-transmission-id'],
      transmission_sig: signatureHeaders['paypal-transmission-sig'],
      transmission_time: signatureHeaders['paypal-transmission-time'],
      webhook_id: 'webhook',
      webhook_event: event,
    });
  });

  it('fails closed for missing signature headers and unsuccessful verification responses', async () => {
    const fetcher = vi.fn();
    const transport = new PayPalPaymentTransport({
      clientId: 'client',
      clientSecret: 'secret',
      mode: 'sandbox',
      fetcher,
    });
    expect(await transport.verifyWebhookSignature('{}', {}, 'webhook')).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
    fetcher
      .mockResolvedValueOnce(json({ access_token: 'access' }))
      .mockResolvedValueOnce(json({ verification_status: 'SUCCESS' }, 500));
    expect(await transport.verifyWebhookSignature('{}', signatureHeaders, 'webhook')).toBe(false);
  });

  it('sends a refund once in the exact consumer amount/currency without retrying', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json({ access_token: 'access' }))
      .mockResolvedValueOnce(json({ id: 'refund', status: 'COMPLETED' }));
    const transport = new PayPalPaymentTransport({
      clientId: 'client',
      clientSecret: 'secret',
      mode: 'live',
      fetcher,
    });
    const request = {
      amount: { value: '12.34', currency_code: 'USD' },
      note_to_payer: 'Requested refund',
    };
    expect(await transport.refundCapture('capture', request)).toEqual({
      id: 'refund',
      status: 'COMPLETED',
    });
    expect(fetcher.mock.calls[1]).toEqual([
      'https://api.paypal.com/v2/payments/captures/capture/refund',
      {
        method: 'POST',
        signal: expect.any(AbortSignal),
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer access' },
        body: JSON.stringify(request),
      },
    ]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('reports a non-JSON refund failure as an HTTP failure carrying its status (M8)', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json({ access_token: 'access' }))
      .mockResolvedValueOnce(new Response('<html>bad gateway</html>', { status: 502 }));
    const transport = new PayPalPaymentTransport({ clientId: 'client', clientSecret: 'secret', mode: 'live', fetcher });
    await expect(transport.refundCapture('capture', {})).rejects.toMatchObject({
      message: 'PayPal refund request failed (502)', statusCode: 502,
    });
  });

  it('rejects missing OAuth tokens before sending a refund', async () => {
    const fetcher = vi.fn().mockResolvedValue(json({ error: 'invalid_client' }, 401));
    const transport = new PayPalPaymentTransport({
      clientId: 'client',
      clientSecret: 'secret',
      mode: 'sandbox',
      fetcher,
    });
    await expect(
      transport.refundCapture('capture', { amount: { value: '1.00', currency_code: 'USD' } }),
    ).rejects.toThrow('access token');
    expect(fetcher).toHaveBeenCalledOnce();
  });
});

it('rejects every unsuccessful refund HTTP response without requiring a provider status', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(json({ access_token: 'test' }))
    .mockResolvedValueOnce(json({ name: 'INTERNAL_SERVER_ERROR' }, 500));
  const transport = new PayPalPaymentTransport({ clientId: 'test', clientSecret: 'test', mode: 'sandbox', fetcher });
  await expect(transport.refundCapture('capture', { amount: { value: '5.00', currency_code: 'USD' } })).rejects.toThrow('500');
});

it('preserves accepted pending refunds and a caller-owned request id', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(json({ access_token: 'test' }))
    .mockResolvedValueOnce(json({ id: 'refund', status: 'PENDING' }, 201));
  const transport = new PayPalPaymentTransport({ clientId: 'test', clientSecret: 'test', mode: 'sandbox', fetcher });
  await expect(transport.refundCapture('capture', { amount: { value: '5.00', currency_code: 'USD' } }, 'refund-request-1')).resolves.toMatchObject({ id: 'refund', status: 'PENDING' });
  expect(fetcher.mock.calls[1][1].headers['PayPal-Request-Id']).toBe('refund-request-1');
});
