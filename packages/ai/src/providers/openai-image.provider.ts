import type OpenAI from 'openai';
import type { ImageProvider, ImageProviderOptions, ImageProviderResult } from '../image-provider';

export type OpenAIImageQuality = 'low' | 'medium' | 'high' | 'auto';
export type OpenAIImageFormat = 'png' | 'jpeg' | 'webp';
export type OpenAIImageModeration = 'low' | 'auto';

export interface OpenAIImageProviderConfig {
  apiKey: string;
  model: string;
  baseURL?: string | null;
  quality: OpenAIImageQuality;
  size: string;
  outputFormat: OpenAIImageFormat;
  moderation: OpenAIImageModeration;
  timeout?: number;
}

// OpenAI SDK 会在请求 timeout 上再加 1 秒保护时间，因此必须为 Node
// 32-bit 计时器上限预留空间。约 24.8 天只作为网络安全边界，业务取消由 signal 决定。
const EFFECTIVELY_UNBOUNDED_TIMEOUT_MS = 2_147_000_000;

export class OpenAIImageProvider implements ImageProvider {
  private clientPromise?: Promise<OpenAI>;
  private readonly config: OpenAIImageProviderConfig;
  private readonly quality: OpenAIImageQuality;
  private readonly size: string;
  private readonly outputFormat: OpenAIImageFormat;
  private readonly moderation: OpenAIImageModeration;

  readonly providerType = 'OpenAI' as const;
  readonly modelId: string;

  constructor(config: OpenAIImageProviderConfig) {
    this.config = config;
    this.modelId = config.model;
    this.quality = config.quality;
    this.size = config.size;
    this.outputFormat = config.outputFormat;
    this.moderation = config.moderation;
  }

  async generateImage(
    prompt: string,
    options?: ImageProviderOptions,
  ): Promise<ImageProviderResult> {
    const client = await this.getClient();
    const start = Date.now();
    const quality = getProviderOption(options, 'quality', this.quality, [
      'low',
      'medium',
      'high',
      'auto',
    ]);
    const outputFormat = getProviderOption(options, 'outputFormat', this.outputFormat, [
      'png',
      'jpeg',
      'webp',
    ]);
    const moderation = getProviderOption(options, 'moderation', this.moderation, ['low', 'auto']);
    const size = getStringProviderOption(options, 'size', this.size);
    const n = normalizeImageCount(options?.numberOfImages);

    const { data: response, request_id: requestId } = await client.images
      .generate(
        {
          model: this.modelId,
          prompt,
          n,
          quality,
          size: size as OpenAI.ImageGenerateParams['size'],
          output_format: outputFormat,
          moderation,
        },
        { signal: options?.signal },
      )
      .withResponse();

    const image = response.data?.[0];
    if (image?.b64_json) {
      return {
        imageBase64: image.b64_json,
        mimeType: toMimeType(outputFormat),
        revisedPrompt: image.revised_prompt,
        providerMeta: {
          provider: 'OpenAI',
          model: this.modelId,
          size,
          quality,
          outputFormat,
          moderation,
          durationMs: Date.now() - start,
          usage: response.usage,
          requestId,
        },
      };
    }

    if (image?.url) {
      return this.fetchImageUrl(
        image.url,
        {
          size,
          quality,
          outputFormat,
          moderation,
          durationMs: Date.now() - start,
          requestId,
        },
        options?.signal,
      );
    }

    throw new Error('OpenAI image generation response did not contain image data');
  }

  private getClient(): Promise<OpenAI> {
    if (!this.clientPromise) {
      this.clientPromise = import('openai')
        .then(
          ({ default: OpenAIClient }) =>
            new OpenAIClient({
              apiKey: this.config.apiKey,
              baseURL: this.config.baseURL || undefined,
              timeout: this.config.timeout ?? EFFECTIVELY_UNBOUNDED_TIMEOUT_MS,
            }),
        )
        .catch((error: unknown) => {
          this.clientPromise = undefined;
          throw error;
        });
    }
    return this.clientPromise;
  }

  private async fetchImageUrl(
    url: string,
    meta: {
      size: string;
      quality: OpenAIImageQuality;
      outputFormat: OpenAIImageFormat;
      moderation: OpenAIImageModeration;
      durationMs: number;
      requestId?: string | null;
    },
    signal?: AbortSignal,
  ): Promise<ImageProviderResult> {
    const resp = await fetch(url, { signal });
    if (!resp.ok) {
      throw new Error(`OpenAI image URL download failed (HTTP ${resp.status})`);
    }
    const contentType = resp.headers.get('content-type') || toMimeType(meta.outputFormat);
    const buffer = Buffer.from(await resp.arrayBuffer());
    return {
      imageBase64: buffer.toString('base64'),
      mimeType: contentType,
      providerMeta: {
        provider: 'OpenAI',
        model: this.modelId,
        ...meta,
      },
    };
  }
}

function getProviderOption<T extends string>(
  options: ImageProviderOptions | undefined,
  key: string,
  fallback: T,
  allowed: readonly T[],
): T {
  const value = options?.providerOptions?.[key];
  return typeof value === 'string' && allowed.includes(value as T) ? (value as T) : fallback;
}

function getStringProviderOption(
  options: ImageProviderOptions | undefined,
  key: string,
  fallback: string,
): string {
  const value = options?.providerOptions?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function normalizeImageCount(value: number | undefined): number {
  if (!value) return 1;
  return Math.min(10, Math.max(1, Math.trunc(value)));
}

function toMimeType(format: OpenAIImageFormat): string {
  return format === 'jpeg' ? 'image/jpeg' : `image/${format}`;
}
