import { describe, expect, it, vi } from 'vitest';
import { runMailProviderCanary, runWebhookProviderCanary } from './provider-canary';
import type { MailProvider } from './mail/mail-provider';

describe('provider probes', () => {
  it('uses the same key and message and requires the same delivery id', async () => {
    const deliver = vi.fn().mockResolvedValue({ success: true, messageId: 'receipt' });
    const provider: MailProvider = {
      name: 'fake',
      supportsIdempotency: true,
      isConfigured: () => true,
      deliver,
      close: vi.fn(),
    };
    const message = { to: 'fixture@example.test', subject: 'probe', text: 'synthetic' };
    await expect(
      runMailProviderCanary({ provider, message, idempotencyKey: 'run', verifyIdempotency: true }),
    ).resolves.toMatchObject({ idempotencyVerified: true });
    expect(deliver).toHaveBeenNthCalledWith(1, message, {
      idempotencyKey: 'run',
      signal: undefined,
    });
    expect(deliver).toHaveBeenNthCalledWith(2, message, {
      idempotencyKey: 'run',
      signal: undefined,
    });
    expect(provider.close).toHaveBeenCalledOnce();
  });
  it('closes the provider on an invalid configuration and on an unproven duplicate', async () => {
    const provider: MailProvider = {
      name: 'fake',
      supportsIdempotency: true,
      isConfigured: () => false,
      deliver: vi.fn(),
      close: vi.fn(),
    };
    const options = {
      provider,
      message: { to: 'fixture@example.test', subject: 'probe' },
      idempotencyKey: 'run',
      verifyIdempotency: true,
    };
    await expect(runMailProviderCanary(options)).rejects.toMatchObject({
      code: 'provider_unavailable',
    });
    expect(provider.close).toHaveBeenCalledOnce();
    provider.isConfigured = () => true;
    provider.deliver = vi
      .fn()
      .mockResolvedValueOnce({ success: true, messageId: 'one' })
      .mockResolvedValueOnce({ success: true, messageId: 'two' });
    await expect(runMailProviderCanary(options)).rejects.toMatchObject({
      code: 'idempotency_unproven',
    });
    expect(provider.close).toHaveBeenCalledTimes(2);
  });
  it('uses the shared HTTP transport with redirects disabled and one request only', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    await expect(
      runWebhookProviderCanary({
        url: 'https://fixture.invalid/hook',
        payload: { probe: 1 },
        timeoutMs: 1000,
        fetch,
      }),
    ).resolves.toEqual({
      channel: 'WEBHOOK',
      outcome: 'success',
      idempotencyVerified: false,
      status: 202,
    });
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      'https://fixture.invalid/hook',
      expect.objectContaining({ method: 'POST', redirect: 'error', body: '{"probe":1}' }),
    );
  });
  it('reports HTTP failure without copying destination credentials into the canary message', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: false, status: 403, statusText: 'Forbidden' });
    await expect(
      runWebhookProviderCanary({
        url: 'https://fixture.invalid/private-key',
        payload: {},
        timeoutMs: 1000,
        fetch,
      }),
    ).rejects.toMatchObject({
      code: 'webhook_http',
      status: 403,
      message: 'Webhook notification canary was rejected with HTTP 403.',
    });
  });
});
