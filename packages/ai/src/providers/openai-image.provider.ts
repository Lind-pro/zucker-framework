import type OpenAI from 'openai';
import {
  ImageProviderConfigError,
  type ImageProvider,
  type ImageProviderOptions,
  type ImageProviderResult,
  type ImageProviderSource,
  type ImageProviderUsage,
} from '../image-provider';

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
const MAX_EDIT_IMAGE_COUNT = 16;
const MAX_EDIT_IMAGE_BYTES = 50 * 1024 * 1024;

export class OpenAIImageProvider implements ImageProvider {
  private clientPromise?: Promise<OpenAI>;
  private readonly config: OpenAIImageProviderConfig;
  private readonly quality: OpenAIImageQuality;
  private readonly size: string;
  private readonly outputFormat: OpenAIImageFormat;
  private readonly moderation: OpenAIImageModeration;

  readonly providerType = 'OpenAI' as const;
  readonly supportsSingleAttempt = true;
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
    if (options?.maxRetries !== undefined && options.maxRetries !== 0) {
      throw new ImageProviderConfigError('Image provider maxRetries only supports 0');
    }
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
        {
          signal: options?.signal,
          ...(options?.maxRetries === 0 ? { maxRetries: 0 } : {}),
        },
      )
      .withResponse();

    const image = response.data?.[0];
    const usage = toImageUsage(response.usage);
    if (image?.b64_json) {
      return {
        imageBase64: image.b64_json,
        mimeType: toMimeType(outputFormat),
        revisedPrompt: image.revised_prompt,
        ...(usage ? { usage } : {}),
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
          usage: response.usage,
          requestId,
        },
        options?.signal,
        usage,
      );
    }

    throw new Error('OpenAI image generation response did not contain image data');
  }

  async editImage(
    prompt: string,
    images: ImageProviderSource[],
    options?: ImageProviderOptions,
  ): Promise<ImageProviderResult> {
    options?.signal?.throwIfAborted();
    if (options?.maxRetries !== undefined && options.maxRetries !== 0) {
      throw new ImageProviderConfigError('Image provider maxRetries only supports 0');
    }
    if (!Array.isArray(images) || images.length < 1 || images.length > MAX_EDIT_IMAGE_COUNT) {
      throw new ImageProviderConfigError('OpenAI image editing requires between 1 and 16 source images');
    }
    // Validate all sources before SDK setup/dispatch. File names contain no caller data.
    const sources = images.map(validateEditSource);
    const client = await this.getClient();
    const { toFile } = await import('openai');
    options?.signal?.throwIfAborted();
    const uploads = await Promise.all(sources.map((source, index) =>
      toFile(source.bytes, `source-${index + 1}.${source.extension}`, { type: source.mimeType }),
    ));
    options?.signal?.throwIfAborted();
    const start = Date.now();
    const quality = getProviderOption(options, 'quality', this.quality, ['low', 'medium', 'high', 'auto']);
    const outputFormat = getProviderOption(options, 'outputFormat', this.outputFormat, ['png', 'jpeg', 'webp']);
    const size = getStringProviderOption(options, 'size', this.size);
    const { data: response, request_id: requestId } = await client.images.edit(
      {
        model: this.modelId, prompt, image: uploads,
        n: normalizeImageCount(options?.numberOfImages), quality,
        size: size as OpenAI.ImageEditParams['size'], output_format: outputFormat,
        // SDK 7.9 does not expose edit moderation; retain the endpoint default.
        // input_fidelity is not universally supported by configured image models.
      },
      { signal: options?.signal, ...(options?.maxRetries === 0 ? { maxRetries: 0 } : {}) },
    ).withResponse();
    options?.signal?.throwIfAborted();
    const image = response.data?.[0];
    const usage = toImageUsage(response.usage);
    const meta = { operation: 'edit' as const, sourceImageCount: sources.length, size, quality, outputFormat,
      durationMs: Date.now() - start, usage: response.usage, requestId };
    if (image?.b64_json) {
      return {
        imageBase64: image.b64_json, mimeType: toMimeType(outputFormat), revisedPrompt: image.revised_prompt,
        ...(usage ? { usage } : {}),
        providerMeta: { provider: 'OpenAI', model: this.modelId, ...meta },
      };
    }
    if (image?.url) return this.fetchImageUrl(image.url, meta, options?.signal, usage);
    throw new Error('OpenAI image editing response did not contain image data');
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
              // Billable, non-idempotent calls: the SDK must not resubmit them on its own.
              maxRetries: 0,
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
      moderation?: OpenAIImageModeration;
      operation?: 'edit';
      sourceImageCount?: number;
      durationMs: number;
      usage?: OpenAI.ImagesResponse.Usage;
      requestId?: string | null;
    },
    signal?: AbortSignal,
    usage?: ImageProviderUsage,
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
      ...(usage ? { usage } : {}),
      providerMeta: {
        provider: 'OpenAI',
        model: this.modelId,
        ...meta,
      },
    };
  }
}

function toImageUsage(usage: OpenAI.ImagesResponse.Usage | undefined): ImageProviderUsage | undefined {
  if (!usage) return undefined;
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    totalTokens: usage.total_tokens,
    inputTokenDetails: toModalityCounts(usage.input_tokens_details),
    outputTokenDetails: toModalityCounts(usage.output_tokens_details),
    raw: { ...usage },
  };
}

function toModalityCounts(
  details: { text_tokens?: number; image_tokens?: number } | undefined,
): Record<string, number> | undefined {
  if (!details) return undefined;
  return {
    ...(details.text_tokens === undefined ? {} : { text: details.text_tokens }),
    ...(details.image_tokens === undefined ? {} : { image: details.image_tokens }),
  };
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

function validateEditSource(source: ImageProviderSource, index: number): {
  bytes: Buffer; mimeType: string; extension: 'png' | 'jpg' | 'webp';
} {
  const fail = (reason: string): never => {
    throw new ImageProviderConfigError(`OpenAI image editing source ${index + 1}: ${reason}`);
  };
  if (!source || !['image/png', 'image/jpeg', 'image/webp'].includes(source.mimeType)) {
    return fail('only PNG, JPEG and WebP source images are supported');
  }
  const base64 = source.imageBase64;
  if (typeof base64 !== 'string' || !base64.length || base64.length % 4 !== 0 ||
      base64.length > Math.ceil(MAX_EDIT_IMAGE_BYTES / 3) * 4 || !/^[a-z0-9+/]+={0,2}$/i.test(base64)) {
    return fail('source must contain valid base64 and be smaller than 50 MiB');
  }
  const bytes = Buffer.from(base64, 'base64');
  if (!bytes.length || bytes.length >= MAX_EDIT_IMAGE_BYTES || bytes.toString('base64') !== base64) {
    return fail('source must contain valid base64 and be smaller than 50 MiB');
  }
  const format = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ? 'png'
    : bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff ? 'jpg'
    : bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' ? 'webp'
    : undefined;
  if (!format || (format === 'jpg' ? 'image/jpeg' : `image/${format}`) !== source.mimeType) {
    return fail('image signature does not match its declared MIME type');
  }
  return { bytes, mimeType: source.mimeType, extension: format };
}
