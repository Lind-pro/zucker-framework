import { describe, expect, it, vi } from 'vitest';
import { requestKrokiSvg } from './kroki-render-client';

describe('requestKrokiSvg', () => {
  it('posts diagram source to the configured endpoint with cancellation', async () => {
    const signal = new AbortController().signal;
    const fetcher = vi.fn(async () => new Response('<svg/>'));
    await expect(
      requestKrokiSvg({
        url: 'http://render.test/graphviz/svg',
        source: 'digraph {}',
        signal,
        fetcher,
      }),
    ).resolves.toMatchObject({ svg: '<svg/>' });
    expect(fetcher).toHaveBeenCalledWith('http://render.test/graphviz/svg', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'digraph {}',
      signal,
    });
  });
  it('bounds HTTP failure data and preserves cancellation identity', async () => {
    await expect(
      requestKrokiSvg({
        url: 'http://render.test/draw',
        source: '',
        fetcher: async () => new Response('x'.repeat(500), { status: 400 }),
      }),
    ).rejects.toMatchObject({ stage: 'http', status: 400, detail: 'x'.repeat(300) });
    const error = new Error('cancelled');
    const controller = new AbortController();
    controller.abort();
    await expect(
      requestKrokiSvg({
        url: 'http://render.test/draw',
        source: '',
        signal: controller.signal,
        fetcher: async () => {
          throw error;
        },
      }),
    ).rejects.toBe(error);
  });
});
