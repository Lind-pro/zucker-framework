import { describe, expect, it, vi } from 'vitest';
import { requestSvgRender, SvgRenderRequestError } from './svg-render-client';

describe('requestSvgRender', () => {
  it('posts the structured spec with cancellation and preserves response metadata', async () => {
    const signal = new AbortController().signal;
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify({ svg: '<svg/>', elementCount: 2 })),
    );
    const result = await requestSvgRender({
      url: 'http://renderer.test/draw',
      spec: { elements: [] },
      signal,
      fetcher,
    });
    expect(fetcher).toHaveBeenCalledWith('http://renderer.test/draw', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"elements":[]}',
      signal,
    });
    expect(result.data).toEqual({ svg: '<svg/>', elementCount: 2 });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('distinguishes HTTP failures and bounds their returned detail', async () => {
    const fetcher = vi.fn(async () => new Response('x'.repeat(500), { status: 422 }));
    await expect(
      requestSvgRender({ url: 'http://renderer.test/draw', spec: {}, fetcher }),
    ).rejects.toMatchObject({ stage: 'http', status: 422, detail: 'x'.repeat(300) });
  });

  it('preserves cancellation error identity while classifying ordinary transport failures', async () => {
    const failure = new Error('connection closed');
    const fetcher = vi.fn(async () => {
      throw failure;
    });
    await expect(
      requestSvgRender({ url: 'http://renderer.test/draw', spec: {}, fetcher }),
    ).rejects.toMatchObject({ stage: 'transport', cause: failure });
    const controller = new AbortController();
    controller.abort();
    await expect(
      requestSvgRender({
        url: 'http://renderer.test/draw',
        spec: {},
        fetcher,
        signal: controller.signal,
      }),
    ).rejects.toBe(failure);
  });

  it.each([null, {}, { svg: '' }, { svg: 1 }])(
    'rejects a missing or invalid SVG: %j',
    async (body) => {
      const fetcher = vi.fn(async () => new Response(JSON.stringify(body)));
      await expect(
        requestSvgRender({ url: 'http://renderer.test/draw', spec: {}, fetcher }),
      ).rejects.toBeInstanceOf(SvgRenderRequestError);
    },
  );
});
