export interface ImageProviderOptions {
  signal?: AbortSignal;
  /** Disable retries inside the provider SDK; omitted retains its default policy. */
  maxRetries?: 0;
  aspectRatio?: '1:1' | '16:9' | '9:16' | '4:3' | '3:4';
  numberOfImages?: number;
  providerOptions?: Record<string, unknown>;
}

/** Provider-reported token counts. Missing counts remain unknown, not zero. */
export interface ImageProviderUsage {
  inputTokens?: number;
  /** Generated tokens, including reported reasoning tokens; category details remain in raw. */
  outputTokens?: number;
  totalTokens?: number;
  /** Modality names such as text/image; only reported counts are included. */
  inputTokenDetails?: Record<string, number>;
  outputTokenDetails?: Record<string, number>;
  /** Complete provider usage, including cache, reasoning and tool token details. */
  raw: Record<string, unknown>;
}

export interface ImageProviderResult {
  imageBase64: string;
  mimeType: string;
  revisedPrompt?: string;
  usage?: ImageProviderUsage;
  providerMeta?: Record<string, unknown>;
}

/** An encoded source image, supplied by the caller without URLs or storage policy. */
export interface ImageProviderSource {
  imageBase64: string;
  mimeType: string;
}

/** Encoded-image output, independent of a product's model routing or schema. */
export interface ImageProvider {
  readonly providerType: string;
  readonly modelId: string;
  /** True only when maxRetries: 0 disables retries inside this provider's SDK. */
  readonly supportsSingleAttempt?: boolean;
  generateImage(prompt: string, options?: ImageProviderOptions): Promise<ImageProviderResult>;
  /** Optional source-image editing. Callers must check support; never fall back to text-only generation. */
  editImage?(
    prompt: string,
    images: ImageProviderSource[],
    options?: ImageProviderOptions,
  ): Promise<ImageProviderResult>;
}

export class ImageProviderConfigError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ImageProviderConfigError';
  }
}
