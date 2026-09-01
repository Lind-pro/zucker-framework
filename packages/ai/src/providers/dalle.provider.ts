import {
  MediaType,
  type MediaProvider,
  type MediaGenerationConfig,
  type MediaGenerationResult,
  type MediaModelInfo,
} from '../media.interface';

// OpenAI Node SDK 4.x 不支持关闭内部 timeout。使用 Node 最大计时器值，
// 将生命周期控制交给 framework 组合出的 AbortSignal，而不是 SDK 的隐式 10 分钟截止。
const EFFECTIVELY_UNBOUNDED_TIMEOUT_MS = 2_147_483_647;

/**
 * DALL-E 图片生成 Provider
 * 基于 OpenAI SDK，支持 DALL-E 3 和 DALL-E 2
 */
export class DalleProvider implements MediaProvider {
  id = 'dalle';
  name = 'DALL-E';
  supportedTypes = [MediaType.IMAGE];

  async generate(prompt: string, config: MediaGenerationConfig): Promise<MediaGenerationResult> {
    const client = await this.createClient(config);
    const modelId = config.modelId || 'dall-e-3';
    const startTime = Date.now();

    const params: Record<string, unknown> = {
      model: modelId,
      prompt,
      response_format: 'url',
    };

    // DALL-E 3 仅支持 n=1
    if (modelId === 'dall-e-3') {
      params.n = 1;
      params.size = this.resolveSize(config.width, config.height);
      if (config.quality) params.quality = config.quality;
      if (config.style) params.style = config.style;
    } else {
      // DALL-E 2 支持 n > 1
      params.n = config.count ?? 1;
      params.size = this.resolveSizeDalle2(config.width, config.height);
    }

    const response = await (client as any).images.generate(params, { signal: config.signal });
    const image = response.data?.[0];

    return {
      url: image?.url,
      base64: image?.b64_json,
      mediaType: MediaType.IMAGE,
      width: config.width,
      height: config.height,
      format: 'png',
      cost: this.estimateCost(modelId, config),
      provider: this.id,
      model: modelId,
      durationMs: Date.now() - startTime,
      revisedPrompt: image?.revised_prompt,
    };
  }

  getModels(): MediaModelInfo[] {
    return [
      {
        id: 'dall-e-3',
        name: 'DALL-E 3',
        mediaType: MediaType.IMAGE,
        maxWidth: 1792,
        maxHeight: 1792,
        supportedFormats: ['png'],
      },
      {
        id: 'dall-e-2',
        name: 'DALL-E 2',
        mediaType: MediaType.IMAGE,
        maxWidth: 1024,
        maxHeight: 1024,
        supportedFormats: ['png'],
      },
    ];
  }

  private async createClient(config: MediaGenerationConfig): Promise<unknown> {
    let mod: typeof import('openai');
    try {
      mod = await import('openai');
    } catch (error) {
      throw new Error('openai package not installed. Run: npm install openai', { cause: error });
    }
    const OpenAI = mod.default ?? mod.OpenAI;
    return new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      timeout: config.timeoutMs ?? EFFECTIVELY_UNBOUNDED_TIMEOUT_MS,
    });
  }

  private resolveSize(width?: number, height?: number): string {
    if (width && height) {
      if (width > height) return '1792x1024';
      if (height > width) return '1024x1792';
    }
    return '1024x1024';
  }

  private resolveSizeDalle2(width?: number, height?: number): string {
    const size = Math.max(width ?? 1024, height ?? 1024);
    if (size <= 256) return '256x256';
    if (size <= 512) return '512x512';
    return '1024x1024';
  }

  private estimateCost(modelId: string, config: MediaGenerationConfig): number {
    const count = config.count ?? 1;
    if (modelId === 'dall-e-3') {
      const isHd = config.quality === 'hd';
      const size = this.resolveSize(config.width, config.height);
      if (size === '1024x1024') return (isHd ? 0.08 : 0.04) * count;
      return (isHd ? 0.12 : 0.08) * count;
    }
    // DALL-E 2
    const size = this.resolveSizeDalle2(config.width, config.height);
    if (size === '256x256') return 0.016 * count;
    if (size === '512x512') return 0.018 * count;
    return 0.02 * count;
  }
}
