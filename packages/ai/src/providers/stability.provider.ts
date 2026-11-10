import {
  MediaType,
  type MediaProvider,
  type MediaGenerationConfig,
  type MediaGenerationResult,
  type MediaModelInfo,
} from '../media.interface';
import { providerRequestSignal } from '../abort-signal';
import { providerHttpError } from '../provider-http-error';

const STABILITY_API_BASE = 'https://api.stability.ai';

/**
 * Stability AI 图片生成 Provider
 * 支持 Stable Diffusion 3.5、SDXL、Stable Image Core
 * 使用 REST API，无需额外 SDK
 */
export class StabilityProvider implements MediaProvider {
  id = 'stability';
  name = 'Stability AI';
  supportedTypes = [MediaType.IMAGE];

  async generate(prompt: string, config: MediaGenerationConfig): Promise<MediaGenerationResult> {
    const modelId = config.modelId || 'sd3.5-large';
    const baseURL = config.baseURL || STABILITY_API_BASE;
    const startTime = Date.now();

    const endpoint = this.getEndpoint(modelId);
    const body = this.buildRequestBody(prompt, modelId, config);

    // FormData 由 fetch 自动设置 Content-Type（含 boundary）
    const response = await fetch(`${baseURL}${endpoint}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        Accept: 'application/json',
      },
      body,
      signal: providerRequestSignal(config.signal, config.timeoutMs),
    });

    if (!response.ok) {
      throw await providerHttpError('Stability', response);
    }

    const data = (await response.json()) as any;
    // v2beta API 返回 data.image (base64)
    const image = data.image;

    if (!image) {
      throw new Error('Stability API 返回空结果');
    }

    return {
      base64: image,
      mediaType: MediaType.IMAGE,
      width: config.width,
      height: config.height,
      format: config.format ?? 'png',
      cost: this.estimateCost(modelId),
      provider: this.id,
      model: modelId,
      durationMs: Date.now() - startTime,
    };
  }

  getModels(): MediaModelInfo[] {
    return [
      {
        id: 'sd3.5-large',
        name: 'Stable Diffusion 3.5 Large',
        mediaType: MediaType.IMAGE,
        maxWidth: 1536,
        maxHeight: 1536,
        supportedFormats: ['png', 'jpeg', 'webp'],
      },
      {
        id: 'sd3.5-medium',
        name: 'Stable Diffusion 3.5 Medium',
        mediaType: MediaType.IMAGE,
        maxWidth: 1536,
        maxHeight: 1536,
        supportedFormats: ['png', 'jpeg', 'webp'],
      },
      {
        id: 'stable-image-core',
        name: 'Stable Image Core',
        mediaType: MediaType.IMAGE,
        maxWidth: 1536,
        maxHeight: 1536,
        supportedFormats: ['png', 'jpeg', 'webp'],
      },
      {
        id: 'stable-image-ultra',
        name: 'Stable Image Ultra',
        mediaType: MediaType.IMAGE,
        maxWidth: 2048,
        maxHeight: 2048,
        supportedFormats: ['png', 'jpeg', 'webp'],
      },
    ];
  }

  private getEndpoint(modelId: string): string {
    switch (modelId) {
      case 'sd3.5-large':
      case 'sd3.5-medium':
      case 'sd3.5-large-turbo':
        return '/v2beta/stable-image/generate/sd3';
      case 'stable-image-core':
        return '/v2beta/stable-image/generate/core';
      case 'stable-image-ultra':
        return '/v2beta/stable-image/generate/ultra';
      default:
        return '/v2beta/stable-image/generate/sd3';
    }
  }

  private buildRequestBody(
    prompt: string,
    modelId: string,
    config: MediaGenerationConfig,
  ): FormData {
    const form = new FormData();
    form.append('prompt', prompt);
    form.append('model', modelId);
    form.append('output_format', config.format ?? 'png');

    if (config.negativePrompt) {
      form.append('negative_prompt', config.negativePrompt);
    }
    if (config.width && config.height) {
      form.append('aspect_ratio', this.toAspectRatio(config.width, config.height));
    }
    if (config.seed !== undefined) {
      form.append('seed', String(config.seed));
    }
    if (config.cfgScale !== undefined) {
      form.append('cfg_scale', String(config.cfgScale));
    }

    return form;
  }

  private toAspectRatio(width: number, height: number): string {
    const ratio = width / height;
    if (ratio >= 1.7) return '16:9';
    if (ratio >= 1.4) return '3:2';
    if (ratio >= 1.2) return '4:3';
    if (ratio >= 0.9) return '1:1';
    if (ratio >= 0.7) return '3:4';
    if (ratio >= 0.55) return '2:3';
    return '9:16';
  }

  private estimateCost(modelId: string): number {
    switch (modelId) {
      case 'stable-image-ultra':
        return 0.08;
      case 'sd3.5-large':
        return 0.065;
      case 'sd3.5-medium':
        return 0.035;
      case 'stable-image-core':
        return 0.03;
      default:
        return 0.04;
    }
  }
}
