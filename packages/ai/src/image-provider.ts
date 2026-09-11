export interface ImageProviderOptions {
  signal?: AbortSignal;
  aspectRatio?: '1:1' | '16:9' | '9:16' | '4:3' | '3:4';
  numberOfImages?: number;
  providerOptions?: Record<string, unknown>;
}

export interface ImageProviderResult {
  imageBase64: string;
  mimeType: string;
  revisedPrompt?: string;
  providerMeta?: Record<string, unknown>;
}

/** Encoded-image output, independent of a product's model routing or schema. */
export interface ImageProvider {
  readonly providerType: string;
  readonly modelId: string;
  generateImage(prompt: string, options?: ImageProviderOptions): Promise<ImageProviderResult>;
}

export class ImageProviderConfigError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ImageProviderConfigError';
  }
}
