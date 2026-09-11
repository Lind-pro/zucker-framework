import { beforeEach, describe, expect, it, vi } from 'vitest';
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
});
