import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAIImageProvider, type OpenAIImageProviderConfig } from './openai-image.provider';

const sdk = vi.hoisted(() => ({ initialize: vi.fn(), generate: vi.fn() }));
vi.mock('openai', () => ({
  default: class {
    constructor(options: unknown) {
      sdk.initialize(options);
    }
    images = { generate: sdk.generate };
  },
}));
const config: OpenAIImageProviderConfig = {
  apiKey: 'test-key',
  model: 'gpt-image-2',
  quality: 'medium',
  size: '1024x1024',
  outputFormat: 'png',
  moderation: 'auto',
};

beforeEach(() => {
  sdk.initialize.mockClear();
  sdk.generate.mockReturnValue({
    withResponse: async () => ({
      data: { data: [{ b64_json: 'aW1hZ2U=' }], usage: { total_tokens: 12 } },
      request_id: 'request-1',
    }),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('OpenAIImageProvider', () => {
  it('preserves cancellation, long timeout and provider request/usage metadata', async () => {
    const provider = new OpenAIImageProvider(config);
    const signal = new AbortController().signal;
    const result = await provider.generateImage('draw a diagram', { signal });
    expect(sdk.initialize).toHaveBeenCalledWith({
      apiKey: 'test-key',
      baseURL: undefined,
      timeout: 2_147_000_000,
    });
    expect(sdk.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-image-2',
        prompt: 'draw a diagram',
        quality: 'medium',
        output_format: 'png',
        moderation: 'auto',
      }),
      { signal },
    );
    expect(result.imageBase64).toBe('aW1hZ2U=');
    expect(result.providerMeta).toMatchObject({
      requestId: 'request-1',
      usage: { total_tokens: 12 },
    });
  });

  it('honors explicit timeout and permitted per-call image overrides', async () => {
    await new OpenAIImageProvider({ ...config, timeout: 45000 }).generateImage('image', {
      numberOfImages: 42,
      providerOptions: { quality: 'high', outputFormat: 'jpeg', moderation: 'invalid' },
    });
    expect(sdk.initialize).toHaveBeenCalledWith(expect.objectContaining({ timeout: 45000 }));
    expect(sdk.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        n: 10,
        quality: 'high',
        output_format: 'jpeg',
        moderation: 'auto',
      }),
      { signal: undefined },
    );
  });

  it('downloads a URL response with the same cancellation signal', async () => {
    sdk.generate.mockReturnValue({
      withResponse: async () => ({
        data: { data: [{ url: 'https://image.test/object' }] },
        request_id: 'url-request',
      }),
    });
    const fetcher = vi.fn(
      async () => new Response('image', { headers: { 'content-type': 'image/webp' } }),
    );
    vi.stubGlobal('fetch', fetcher);
    const signal = new AbortController().signal;
    const result = await new OpenAIImageProvider(config).generateImage('image', { signal });
    expect(fetcher).toHaveBeenCalledWith('https://image.test/object', { signal });
    expect(result.mimeType).toBe('image/webp');
    expect(result.imageBase64).toBe('aW1hZ2U=');
    expect(result.providerMeta?.requestId).toBe('url-request');
  });
});
