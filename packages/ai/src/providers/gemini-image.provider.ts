import type { GoogleGenAI } from '@google/genai';
import type { ImageProvider, ImageProviderOptions, ImageProviderResult } from '../image-provider';

export interface GeminiImageProviderConfig {
  apiKey: string;
  model: string;
  timeout?: number;
}

/** Gemini multimodal image generation, with SDK loading isolated to actual use. */
export class GeminiImageProvider implements ImageProvider {
  readonly providerType = 'Gemini';
  readonly modelId: string;
  private clientPromise?: Promise<GoogleGenAI>;

  constructor(private readonly config: GeminiImageProviderConfig) {
    this.modelId = config.model;
  }

  async generateImage(
    prompt: string,
    options?: ImageProviderOptions,
  ): Promise<ImageProviderResult> {
    const client = await this.getClient();
    const response = await client.models.generateContent({
      model: this.modelId,
      contents: prompt,
      config: {
        responseModalities: ['TEXT', 'IMAGE'],
        abortSignal: options?.signal,
      },
    });
    const parts = response.candidates?.[0]?.content?.parts;
    const image = parts?.find((part) =>
      part.inlineData?.mimeType?.startsWith('image/'),
    )?.inlineData;
    if (!image?.data) throw new Error('Gemini response did not contain image data');
    return {
      imageBase64: image.data,
      mimeType: image.mimeType || 'image/png',
      revisedPrompt: parts?.find((part) => part.text)?.text,
      providerMeta: { provider: this.providerType, model: this.modelId },
    };
  }

  private getClient(): Promise<GoogleGenAI> {
    if (!this.clientPromise) {
      this.clientPromise = import('@google/genai')
        .then(
          ({ GoogleGenAI: Client }) =>
            new Client({
              apiKey: this.config.apiKey,
              httpOptions:
                this.config.timeout === undefined ? undefined : { timeout: this.config.timeout },
            }),
        )
        .catch((error: unknown) => {
          this.clientPromise = undefined;
          throw error;
        });
    }
    return this.clientPromise;
  }
}
