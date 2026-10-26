import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ImageProviderConfigError } from '../image-provider';
import { GeminiImageProvider } from './gemini-image.provider';

const sdk = vi.hoisted(() => ({ initialize: vi.fn(), generate: vi.fn() }));
vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    constructor(options: unknown) {
      sdk.initialize(options);
    }
    models = { generateContent: sdk.generate };
  },
}));
beforeEach(() => {
  sdk.initialize.mockClear();
  sdk.generate.mockReset();
});

describe('GeminiImageProvider', () => {
  it('uses configured models and returns the first image and accompanying text', async () => {
    sdk.generate.mockResolvedValue({
      candidates: [
        {
          content: {
            parts: [
              { text: 'description' },
              { inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' } },
            ],
          },
        },
      ],
    });
    const signal = new AbortController().signal;
    const provider = new GeminiImageProvider({
      apiKey: 'test-key',
      model: 'configured-model',
      timeout: 45000,
    });
    const result = await provider.generateImage('draw', { signal });
    expect(sdk.initialize).toHaveBeenCalledWith({
      apiKey: 'test-key',
      httpOptions: { timeout: 45000 },
    });
    expect(sdk.generate).toHaveBeenCalledWith({
      model: 'configured-model',
      contents: 'draw',
      config: { responseModalities: ['TEXT', 'IMAGE'], abortSignal: signal },
    });
    expect(result).toEqual({
      imageBase64: 'aW1hZ2U=',
      mimeType: 'image/png',
      revisedPrompt: 'description',
      providerMeta: { provider: 'Gemini', model: 'configured-model' },
    });
  });

  it('rejects empty image content and preserves SDK failure identity', async () => {
    const provider = new GeminiImageProvider({ apiKey: 'test-key', model: 'configured-model' });
    sdk.generate.mockResolvedValue({
      candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: '' } }] } }],
    });
    await expect(provider.generateImage('draw')).rejects.toThrow('did not contain image data');
    const error = new Error('cancelled');
    sdk.generate.mockRejectedValue(error);
    await expect(provider.generateImage('draw')).rejects.toBe(error);
  });

  it('disables SDK retries and preserves modality, reasoning, cached and tool usage', async () => {
    const usageMetadata = {
      promptTokenCount: 10,
      candidatesTokenCount: 26,
      totalTokenCount: 43,
      promptTokensDetails: [{ modality: 'TEXT', tokenCount: 10 }],
      candidatesTokensDetails: [
        { modality: 'TEXT', tokenCount: 1 },
        { modality: 'IMAGE', tokenCount: 25 },
      ],
      thoughtsTokenCount: 5,
      cachedContentTokenCount: 3,
      cacheTokensDetails: [{ modality: 'TEXT', tokenCount: 3 }],
      toolUsePromptTokenCount: 2,
      toolUsePromptTokensDetails: [{ modality: 'TEXT', tokenCount: 2 }],
    };
    sdk.generate.mockResolvedValue({
      candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' } }] } }],
      usageMetadata,
      responseId: 'controlled-request',
      modelVersion: 'configured-model-version',
    });
    const provider = new GeminiImageProvider({
      apiKey: 'test-key',
      model: 'configured-model',
      timeout: 45000,
    });
    const signal = new AbortController().signal;
    const result = await provider.generateImage('draw', { signal, maxRetries: 0 });
    expect(provider.supportsSingleAttempt).toBe(true);
    expect(sdk.generate).toHaveBeenCalledWith({
      model: 'configured-model',
      contents: 'draw',
      config: {
        responseModalities: ['TEXT', 'IMAGE'],
        abortSignal: signal,
        httpOptions: { retryOptions: { attempts: 1 } },
      },
    });
    expect(result.usage).toEqual({
      inputTokens: 10,
      outputTokens: 31,
      totalTokens: 43,
      inputTokenDetails: { text: 10 },
      outputTokenDetails: { text: 1, image: 25 },
      raw: usageMetadata,
    });
    expect(result.providerMeta).toMatchObject({
      usage: usageMetadata,
      requestId: 'controlled-request',
      modelVersion: 'configured-model-version',
    });
  });

  it('keeps absent usage and modality counts unknown', async () => {
    const image = { inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' } };
    sdk.generate.mockResolvedValue({ candidates: [{ content: { parts: [image] } }] });
    const provider = new GeminiImageProvider({ apiKey: 'test-key', model: 'configured-model' });
    expect((await provider.generateImage('draw')).usage).toBeUndefined();
    const usageMetadata = {
      promptTokenCount: 10,
      totalTokenCount: 20,
      thoughtsTokenCount: 2,
      promptTokensDetails: [{ modality: 'TEXT' }],
    };
    sdk.generate.mockResolvedValue({ candidates: [{ content: { parts: [image] } }], usageMetadata });
    expect((await provider.generateImage('draw')).usage).toEqual({
      inputTokens: 10,
      outputTokens: undefined,
      totalTokens: 20,
      inputTokenDetails: {},
      outputTokenDetails: undefined,
      raw: usageMetadata,
    });
  });

  it('propagates a single-attempt SDK failure and rejects unsupported retry options before dispatch', async () => {
    const error = new Error('cancelled');
    sdk.generate.mockRejectedValue(error);
    const provider = new GeminiImageProvider({ apiKey: 'test-key', model: 'configured-model' });
    await expect(provider.generateImage('draw', { maxRetries: 0 })).rejects.toBe(error);
    expect(sdk.generate).toHaveBeenCalledTimes(1);
    sdk.generate.mockClear();
    await expect(provider.generateImage('draw', { maxRetries: 1 as 0 })).rejects.toBeInstanceOf(
      ImageProviderConfigError,
    );
    expect(sdk.generate).not.toHaveBeenCalled();
  });
});
