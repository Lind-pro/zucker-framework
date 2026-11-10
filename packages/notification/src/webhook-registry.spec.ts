import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebhookRegistry } from './webhook-registry';

describe('WebhookRegistry', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('verifies the signature header exactly as it is sent and the bare digest', () => {
    const body = '{"event":"x"}';
    const digest = WebhookRegistry.sign(body, 'secret');
    expect(WebhookRegistry.verify(body, `sha256=${digest}`, 'secret')).toBe(true);
    expect(WebhookRegistry.verify(body, digest, 'secret')).toBe(true);
    expect(WebhookRegistry.verify(body, `sha256=${digest}`, 'other')).toBe(false);
  });

  it('signs outgoing deliveries so verify() accepts the header value', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);
    const registry = new WebhookRegistry({ maxRetries: 0 });
    registry.register({ id: 'wh', url: 'https://example.test/hook', events: ['*'], secret: 's' });

    await registry.dispatch('user.created', { id: 1 });

    const init = fetchMock.mock.calls[0][1] as { body: string; headers: Record<string, string> };
    expect(WebhookRegistry.verify(init.body, init.headers['X-Webhook-Signature'], 's')).toBe(true);
  });

  it('retries 429 but not other 4xx', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({ ok: false, status: 429 })
        .mockResolvedValueOnce({ ok: true, status: 200 });
      vi.stubGlobal('fetch', fetchMock);
      const registry = new WebhookRegistry({ maxRetries: 1 });
      registry.register({ id: 'wh', url: 'https://example.test/hook', events: ['*'] });
      const pending = registry.dispatch('e', {});
      await vi.advanceTimersByTimeAsync(1_000);
      const [record] = await pending;
      expect(record.status).toBe('success');
      expect(record.attempts).toBe(2);

      fetchMock.mockReset().mockResolvedValue({ ok: false, status: 400 });
      const [rejected] = await registry.dispatch('e', {});
      expect(rejected).toMatchObject({ status: 'failed', attempts: 1 });
    } finally {
      vi.useRealTimers();
    }
  });
});
