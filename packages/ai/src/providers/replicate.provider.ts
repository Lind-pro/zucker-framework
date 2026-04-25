import type {
  MediaProvider,
  MediaGenerationConfig,
  MediaGenerationResult,
  MediaModelInfo,
  MediaTaskResult,
} from '../media.interface';
import { MediaTaskStatus, MediaType } from '../media.interface';

/** Replicate 预定义模型映射 */
const REPLICATE_MODELS: Record<
  string,
  { owner: string; model: string; version?: string; mediaType: MediaType }
> = {
  'flux-1.1-pro': {
    owner: 'black-forest-labs',
    model: 'flux-1.1-pro',
    mediaType: MediaType.IMAGE,
  },
  'flux-schnell': {
    owner: 'black-forest-labs',
    model: 'flux-schnell',
    mediaType: MediaType.IMAGE,
  },
  'sdxl': {
    owner: 'stability-ai',
    model: 'sdxl',
    mediaType: MediaType.IMAGE,
  },
};

/**
 * Replicate Provider
 * 支持 Flux、Stable Diffusion 等开源模型
 * SDK: replicate
 */
export class ReplicateProvider implements MediaProvider {
  id = 'replicate';
  name = 'Replicate';
  supportedTypes = [MediaType.IMAGE, MediaType.VIDEO];

  async generate(
    prompt: string,
    config: MediaGenerationConfig,
  ): Promise<MediaGenerationResult | MediaTaskResult> {
    const client = await this.createClient(config);
    const modelId = config.modelId || 'flux-1.1-pro';
    const mapping = REPLICATE_MODELS[modelId];
    const startTime = Date.now();

    const input: Record<string, unknown> = { prompt };

    if (config.width) input.width = config.width;
    if (config.height) input.height = config.height;
    if (config.negativePrompt) input.negative_prompt = config.negativePrompt;
    if (config.seed !== undefined) input.seed = config.seed;
    if (config.steps) input.num_inference_steps = config.steps;
    if (config.cfgScale) input.guidance_scale = config.cfgScale;
    if (config.referenceImageUrl) input.image = config.referenceImageUrl;
    if (config.imageStrength !== undefined) input.prompt_strength = config.imageStrength;
    if (config.format) input.output_format = config.format;
    if (config.count) input.num_outputs = config.count;

    const modelRef = mapping
      ? `${mapping.owner}/${mapping.model}`
      : modelId;

    // run() 是阻塞调用，等待完成后返回结果
    const output = await (client as any).run(modelRef, { input });
    const durationMs = Date.now() - startTime;

    // Replicate run() 返回 URL 数组或单个 URL（FileOutput）
    const url = Array.isArray(output) ? output[0] : output;
    const urlStr = typeof url === 'string'
      ? url
      : url?.url?.() ?? String(url);

    return {
      url: urlStr,
      mediaType: MediaType.IMAGE,
      width: config.width,
      height: config.height,
      format: config.format ?? 'webp',
      cost: this.estimateCost(modelId),
      provider: this.id,
      model: modelId,
      durationMs,
    };
  }

  async getTaskStatus(
    taskId: string,
    config: MediaGenerationConfig,
  ): Promise<MediaTaskResult> {
    const client = await this.createClient(config);
    const prediction = await (client as any).predictions.get(taskId);

    const statusMap: Record<string, MediaTaskStatus> = {
      starting: MediaTaskStatus.PENDING,
      processing: MediaTaskStatus.PROCESSING,
      succeeded: MediaTaskStatus.COMPLETED,
      failed: MediaTaskStatus.FAILED,
      canceled: MediaTaskStatus.FAILED,
    };

    const status = statusMap[prediction.status] ?? MediaTaskStatus.PROCESSING;
    const result: MediaTaskResult = {
      taskId,
      status,
      provider: this.id,
    };

    if (status === MediaTaskStatus.COMPLETED && prediction.output) {
      const url = Array.isArray(prediction.output)
        ? prediction.output[0]
        : prediction.output;
      result.result = {
        url,
        mediaType: MediaType.IMAGE,
        cost: this.estimateCost(prediction.model ?? ''),
        provider: this.id,
        model: prediction.model ?? '',
        durationMs: prediction.metrics?.predict_time
          ? prediction.metrics.predict_time * 1000
          : 0,
      };
    }

    if (status === MediaTaskStatus.FAILED) {
      result.error = prediction.error ?? '生成失败';
    }

    return result;
  }

  getModels(): MediaModelInfo[] {
    return [
      {
        id: 'flux-1.1-pro',
        name: 'Flux 1.1 Pro',
        mediaType: MediaType.IMAGE,
        maxWidth: 1440,
        maxHeight: 1440,
        supportedFormats: ['png', 'jpeg', 'webp'],
      },
      {
        id: 'flux-schnell',
        name: 'Flux Schnell',
        mediaType: MediaType.IMAGE,
        maxWidth: 1440,
        maxHeight: 1440,
        supportedFormats: ['png', 'jpeg', 'webp'],
      },
      {
        id: 'sdxl',
        name: 'Stable Diffusion XL',
        mediaType: MediaType.IMAGE,
        maxWidth: 1024,
        maxHeight: 1024,
        supportedFormats: ['png', 'jpeg', 'webp'],
      },
    ];
  }

  private async createClient(config: MediaGenerationConfig): Promise<unknown> {
    try {
      const mod = await import('replicate' as string);
      const Replicate = mod.default ?? mod.Replicate;
      return new Replicate({ auth: config.apiKey });
    } catch {
      throw new Error(
        'replicate package not installed. Run: npm install replicate',
      );
    }
  }

  private estimateCost(modelId: string): number {
    switch (modelId) {
      case 'flux-1.1-pro':
        return 0.04;
      case 'flux-schnell':
        return 0.003;
      case 'sdxl':
        return 0.005;
      default:
        return 0.01;
    }
  }
}
