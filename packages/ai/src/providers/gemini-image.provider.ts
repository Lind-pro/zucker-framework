import type {
  GenerateContentResponseUsageMetadata,
  GoogleGenAI,
  ModalityTokenCount,
} from '@google/genai';
import {
  ImageProviderConfigError,
  type ImageProvider,
  type ImageProviderOptions,
  type ImageProviderResult,
  type ImageProviderUsage,
} from '../image-provider';

export interface GeminiImageProviderConfig {
  apiKey: string;
  model: string;
  timeout?: number;
}

/** Gemini multimodal image generation, with SDK loading isolated to actual use. */
export class GeminiImageProvider implements ImageProvider {
  readonly providerType = 'Gemini';
  readonly supportsSingleAttempt = true;
  readonly modelId: string;
  private clientPromise?: Promise<GoogleGenAI>;

  constructor(private readonly config: GeminiImageProviderConfig) {
    this.modelId = config.model;
  }

  async generateImage(
    prompt: string,
    options?: ImageProviderOptions,
  ): Promise<ImageProviderResult> {
    if (options?.maxRetries !== undefined && options.maxRetries !== 0) {
      throw new ImageProviderConfigError('Image provider maxRetries only supports 0');
    }
    const client = await this.getClient();
    const response = await client.models.generateContent({
      model: this.modelId,
      contents: prompt,
      config: {
        responseModalities: ['TEXT', 'IMAGE'],
        abortSignal: options?.signal,
        ...(options?.maxRetries === 0 ? { httpOptions: { retryOptions: { attempts: 1 } } } : {}),
      },
    });
    const parts = response.candidates?.[0]?.content?.parts;
    const image = parts?.find((part) =>
      part.inlineData?.mimeType?.startsWith('image/'),
    )?.inlineData;
    if (!image?.data) throw new Error('Gemini response did not contain image data');
    const usage = toImageUsage(response.usageMetadata);
    return {
      imageBase64: image.data,
      mimeType: image.mimeType || 'image/png',
      revisedPrompt: parts?.find((part) => part.text)?.text,
      ...(usage ? { usage } : {}),
      providerMeta: {
        provider: this.providerType,
        model: this.modelId,
        ...(response.usageMetadata ? { usage: response.usageMetadata } : {}),
        ...(response.responseId ? { requestId: response.responseId } : {}),
        ...(response.modelVersion ? { modelVersion: response.modelVersion } : {}),
      },
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

function toImageUsage(
  usage: GenerateContentResponseUsageMetadata | undefined,
): ImageProviderUsage | undefined {
  if (!usage) return undefined;
  return {
    inputTokens: usage.promptTokenCount,
    outputTokens:
      usage.candidatesTokenCount === undefined
        ? undefined
        : usage.candidatesTokenCount + (usage.thoughtsTokenCount ?? 0),
    totalTokens: usage.totalTokenCount,
    inputTokenDetails: toModalityCounts(usage.promptTokensDetails),
    outputTokenDetails: toModalityCounts(usage.candidatesTokensDetails),
    raw: { ...usage },
  };
}

function toModalityCounts(details: ModalityTokenCount[] | undefined): Record<string, number> | undefined {
  if (!details) return undefined;
  const counts: Record<string, number> = {};
  for (const detail of details) {
    if (detail.modality !== undefined && detail.tokenCount !== undefined) {
      const modality = detail.modality.toLowerCase();
      counts[modality] = (counts[modality] ?? 0) + detail.tokenCount;
    }
  }
  return counts;
}
