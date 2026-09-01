// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';
import { DalleProvider } from './dalle.provider';

describe('DalleProvider cancellation', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not inherit the OpenAI SDK default timeout', async () => {
    const provider = new DalleProvider();
    const client = await (
      provider as unknown as {
        createClient(config: { apiKey: string; modelId: string }): Promise<{ timeout: number }>;
      }
    ).createClient({ apiKey: 'test-key', modelId: 'dall-e-3' });

    expect(client.timeout).toBe(2_147_483_647);
  });

  it('passes cancellation through to the OpenAI network request', async () => {
    const fetchMock = vi.fn((_url: unknown, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => {
            reject(new DOMException('Aborted', 'AbortError'));
          },
          { once: true },
        );
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const provider = new DalleProvider();
    const controller = new AbortController();

    const generation = provider.generate('draw a patent figure', {
      apiKey: 'test-key',
      modelId: 'dall-e-3',
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    controller.abort();

    await expect(generation).rejects.toThrow();
  });
});
