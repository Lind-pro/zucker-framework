import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImageProviderConfigError } from '../image-provider';
import { OpenAIImageProvider, type OpenAIImageProviderConfig } from './openai-image.provider';

const sdk = vi.hoisted(() => ({ initialize: vi.fn(), generate: vi.fn(), edit: vi.fn(), toFile: vi.fn() }));
vi.mock('openai', () => ({
  toFile: sdk.toFile,
  default: class {
    constructor(options: unknown) {
      sdk.initialize(options);
    }
    images = { generate: sdk.generate, edit: sdk.edit };
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
  sdk.generate.mockReset();
  sdk.edit.mockReset();
  sdk.toFile.mockReset().mockImplementation(async (bytes: Buffer, name: string, options: { type: string }) => ({ bytes, name, type: options.type }));
  sdk.edit.mockReturnValue({ withResponse: async () => ({ data: { data: [{ b64_json: 'ZWRpdGVk' }], usage: { input_tokens: 7, output_tokens: 9, total_tokens: 16 } }, request_id: 'edit-request' }) });
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
      maxRetries: 0,
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
    expect(result.usage).toMatchObject({ totalTokens: 12, raw: { total_tokens: 12 } });
    expect(result.usage?.inputTokens).toBeUndefined();
    expect(result.usage?.outputTokenDetails).toBeUndefined();
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
        data: {
          data: [{ url: 'https://image.test/object' }],
          usage: {
            input_tokens: 7,
            input_tokens_details: { text_tokens: 5, image_tokens: 2 },
            output_tokens: 13,
            output_tokens_details: { text_tokens: 3, image_tokens: 10 },
            total_tokens: 20,
          },
        },
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
    expect(result.usage).toMatchObject({
      inputTokens: 7,
      outputTokens: 13,
      totalTokens: 20,
      inputTokenDetails: { text: 5, image: 2 },
      outputTokenDetails: { text: 3, image: 10 },
    });
    expect(result.usage?.raw).toEqual(result.providerMeta?.usage);
  });

  it('disables SDK retries per controlled call without changing cancellation or full usage', async () => {
    const usage = {
      input_tokens: 8,
      input_tokens_details: { text_tokens: 8, image_tokens: 0 },
      output_tokens: 20,
      output_tokens_details: { image_tokens: 20, text_tokens: 0 },
      total_tokens: 28,
      additional_billing_category: { tokens: 4 },
    };
    sdk.generate.mockReturnValue({
      withResponse: async () => ({
        data: { data: [{ b64_json: 'aW1hZ2U=' }], usage },
        request_id: 'controlled-request',
      }),
    });
    const signal = new AbortController().signal;
    const provider = new OpenAIImageProvider(config);
    const result = await provider.generateImage('draw', { signal, maxRetries: 0 });
    expect(provider.supportsSingleAttempt).toBe(true);
    expect(sdk.generate).toHaveBeenCalledWith(expect.any(Object), { signal, maxRetries: 0 });
    expect(result.usage).toEqual({
      inputTokens: 8,
      outputTokens: 20,
      totalTokens: 28,
      inputTokenDetails: { text: 8, image: 0 },
      outputTokenDetails: { image: 20, text: 0 },
      raw: usage,
    });
    expect(result.providerMeta?.usage).toEqual(usage);
  });

  it('propagates a single-attempt SDK failure and rejects unsupported retry options before dispatch', async () => {
    const error = new Error('cancelled');
    sdk.generate.mockReturnValue({ withResponse: async () => { throw error; } });
    const provider = new OpenAIImageProvider(config);
    await expect(provider.generateImage('draw', { maxRetries: 0 })).rejects.toBe(error);
    expect(sdk.generate).toHaveBeenCalledTimes(1);
    sdk.generate.mockClear();
    await expect(provider.generateImage('draw', { maxRetries: 1 as 0 })).rejects.toBeInstanceOf(
      ImageProviderConfigError,
    );
    expect(sdk.generate).not.toHaveBeenCalled();
  });
});

const sources = [
  { mimeType: 'image/png', imageBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJZkAAAAASUVORK5CYII=' },
  { mimeType: 'image/jpeg', imageBase64: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 1, 2, 0xff, 0xd9]).toString('base64') },
  { mimeType: 'image/webp', imageBase64: Buffer.from('RIFF\x04\x00\x00\x00WEBP', 'binary').toString('base64') },
];

describe('OpenAIImageProvider source-image edits', () => {
  it.each(['gpt-image-2.5-sunburst', 'gpt-image-2.5-flare', 'tenant-image-deployment'])('sends every original source through edits using configured model %s', async model => {
    const provider = new OpenAIImageProvider({ ...config, model, baseURL: 'https://deployment.test/v1' });
    const signal = new AbortController().signal;
    const result = await provider.editImage('Move only the specified handle', sources, { signal, maxRetries: 0 });
    expect(sdk.toFile).toHaveBeenCalledTimes(3);
    for (let i = 0; i < sources.length; i++) {
      expect(sdk.toFile.mock.calls[i]).toEqual([Buffer.from(sources[i].imageBase64, 'base64'), `source-${i + 1}.${['png', 'jpg', 'webp'][i]}`, { type: sources[i].mimeType }]);
    }
    const [body, request] = sdk.edit.mock.calls[0];
    expect(body).toMatchObject({ model, prompt: 'Move only the specified handle', n: 1, quality: 'medium', output_format: 'png', size: '1024x1024' });
    expect(body.image.map((file: { bytes: Buffer }) => file.bytes)).toEqual(sources.map(source => Buffer.from(source.imageBase64, 'base64')));
    expect(body).not.toHaveProperty('moderation'); expect(body).not.toHaveProperty('input_fidelity');
    expect(request).toEqual({ signal, maxRetries: 0 });
    expect(sdk.generate).not.toHaveBeenCalled();
    expect(result).toMatchObject({ imageBase64: 'ZWRpdGVk', mimeType: 'image/png', usage: { inputTokens: 7, outputTokens: 9, totalTokens: 16 },
      providerMeta: { operation: 'edit', sourceImageCount: 3, model, requestId: 'edit-request' } });
  });

  it('supports sixteen sources and explicit output overrides without changing SDK default retries', async () => {
    await new OpenAIImageProvider(config).editImage('Preserve the shared mechanism', Array.from({ length: 16 }, () => sources[0]), {
      numberOfImages: 2, providerOptions: { quality: 'high', size: '1536x1024', outputFormat: 'webp' },
    });
    expect(sdk.edit).toHaveBeenCalledWith(expect.objectContaining({ n: 2, quality: 'high', size: '1536x1024', output_format: 'webp', image: expect.arrayContaining([expect.objectContaining({ type: 'image/png' })]) }), { signal: undefined });
    expect(sdk.toFile).toHaveBeenCalledTimes(16);
  });

  it.each([
    [], Array.from({ length: 17 }, () => sources[0]),
    [{ ...sources[0], mimeType: 'image/svg+xml' }], [{ ...sources[0], mimeType: 'image/jpeg' }],
    [{ ...sources[0], imageBase64: '' }], [{ ...sources[0], imageBase64: 'data:image/png;base64,' + sources[0].imageBase64 }],
    [{ ...sources[0], imageBase64: '%%%%' }], [{ ...sources[0], imageBase64: 'dGV4dA==' }],
    [{ ...sources[0], imageBase64: 'AB==' }],
  ].map(images => [images]))('rejects invalid source arrays before SDK dispatch: %#', async images => {
    await expect(new OpenAIImageProvider(config).editImage('edit', images)).rejects.toBeInstanceOf(ImageProviderConfigError);
    expect(sdk.initialize).not.toHaveBeenCalled(); expect(sdk.edit).not.toHaveBeenCalled(); expect(sdk.generate).not.toHaveBeenCalled();
  });

  it('rejects a source at the fifty MiB boundary before SDK dispatch', async () => {
    const bytes = Buffer.alloc(50 * 1024 * 1024); Buffer.from(sources[0].imageBase64, 'base64').copy(bytes);
    await expect(new OpenAIImageProvider(config).editImage('edit', [{ mimeType: 'image/png', imageBase64: bytes.toString('base64') }])).rejects.toThrow('smaller than 50 MiB');
    expect(sdk.initialize).not.toHaveBeenCalled(); expect(sdk.edit).not.toHaveBeenCalled();
  });

  it('propagates cancellation before source conversion, during SDK work and after completion', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(new OpenAIImageProvider(config).editImage('edit', sources, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(sdk.toFile).not.toHaveBeenCalled(); expect(sdk.edit).not.toHaveBeenCalled();
    const failure = new Error('cancelled by SDK');
    sdk.edit.mockReturnValue({ withResponse: async () => { throw failure; } });
    await expect(new OpenAIImageProvider(config).editImage('edit', sources, { maxRetries: 0 })).rejects.toBe(failure);
    expect(sdk.edit).toHaveBeenCalledTimes(1); expect(sdk.generate).not.toHaveBeenCalled();
    const late = new AbortController();
    sdk.edit.mockReturnValue({ withResponse: async () => { late.abort(); return { data: { data: [{ b64_json: 'ZWRpdGVk' }] } }; } });
    await expect(new OpenAIImageProvider(config).editImage('edit', sources, { signal: late.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('downloads edited URL output with usage and cancellation intact', async () => {
    const usage = { input_tokens: 9, input_tokens_details: { text_tokens: 2, image_tokens: 7 }, output_tokens: 5, total_tokens: 14, provider_extension: 3 };
    sdk.edit.mockReturnValue({ withResponse: async () => ({ data: { data: [{ url: 'https://output.test/image.png' }], usage }, request_id: 'edit-url' }) });
    const fetcher = vi.fn(async () => new Response('edited', { headers: { 'content-type': 'image/png' } })); vi.stubGlobal('fetch', fetcher);
    const signal = new AbortController().signal;
    const result = await new OpenAIImageProvider(config).editImage('edit', sources, { signal });
    expect(fetcher).toHaveBeenCalledWith('https://output.test/image.png', { signal });
    expect(result.imageBase64).toBe('ZWRpdGVk');
    expect(result.usage).toMatchObject({ inputTokens: 9, inputTokenDetails: { text: 2, image: 7 }, raw: usage });
    expect(result.providerMeta).toMatchObject({ operation: 'edit', sourceImageCount: 3, requestId: 'edit-url', usage });
  });

  it('rejects unsupported retry options and missing image output without text-only fallback', async () => {
    await expect(new OpenAIImageProvider(config).editImage('edit', sources, { maxRetries: 1 as 0 })).rejects.toBeInstanceOf(ImageProviderConfigError);
    expect(sdk.edit).not.toHaveBeenCalled();
    sdk.edit.mockReturnValue({ withResponse: async () => ({ data: { data: [] } }) });
    await expect(new OpenAIImageProvider(config).editImage('edit', sources)).rejects.toThrow('did not contain image data');
    expect(sdk.edit).toHaveBeenCalledTimes(1); expect(sdk.generate).not.toHaveBeenCalled();
  });
});
