import {
  MediaTaskStatus,
  MediaType,
  type MediaProvider,
  type MediaGenerationConfig,
  type MediaModelInfo,
  type MediaTaskResult,
} from '../media.interface';
import { providerRequestSignal } from '../abort-signal';
import { providerHttpError } from '../provider-http-error';

const RUNWAY_API_BASE = 'https://api.dev.runwayml.com/v1';

/**
 * Runway 视频生成 Provider
 * 支持 Gen-3 Alpha / Gen-3 Alpha Turbo
 * 异步模式：提交任务 → 轮询状态 → 获取结果
 */
export class RunwayProvider implements MediaProvider {
  id = 'runway';
  name = 'Runway';
  supportedTypes = [MediaType.VIDEO];

  async generate(prompt: string, config: MediaGenerationConfig): Promise<MediaTaskResult> {
    const baseURL = config.baseURL || RUNWAY_API_BASE;
    const modelId = config.modelId || 'gen3a_turbo';

    const body: Record<string, unknown> = {
      model: modelId,
      promptText: prompt,
      duration: config.duration ?? 5,
      ratio: this.resolveRatio(config.resolution),
    };

    if (config.firstFrameUrl) {
      body.promptImage = config.firstFrameUrl;
    }
    if (config.lastFrameUrl) {
      body.lastFrame = { uri: config.lastFrameUrl, type: 'image' };
    }

    const endpoint = config.firstFrameUrl ? '/image_to_video' : '/text_to_video';
    const response = await fetch(`${baseURL}${endpoint}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
        'X-Runway-Version': '2024-11-06',
      },
      body: JSON.stringify(body),
      signal: providerRequestSignal(config.signal, config.timeoutMs),
    });

    if (!response.ok) {
      throw await providerHttpError('Runway', response);
    }

    const data = (await response.json()) as any;

    return {
      taskId: data.id,
      status: MediaTaskStatus.PROCESSING,
      provider: this.id,
    };
  }

  async getTaskStatus(taskId: string, config: MediaGenerationConfig): Promise<MediaTaskResult> {
    const baseURL = config.baseURL || RUNWAY_API_BASE;

    const response = await fetch(`${baseURL}/tasks/${encodeURIComponent(taskId)}`, {
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'X-Runway-Version': '2024-11-06',
      },
      signal: providerRequestSignal(config.signal, config.timeoutMs),
    });

    if (!response.ok) {
      throw await providerHttpError('Runway', response);
    }

    const data = (await response.json()) as any;

    const statusMap: Record<string, MediaTaskStatus> = {
      PENDING: MediaTaskStatus.PENDING,
      THROTTLED: MediaTaskStatus.PENDING,
      RUNNING: MediaTaskStatus.PROCESSING,
      SUCCEEDED: MediaTaskStatus.COMPLETED,
      FAILED: MediaTaskStatus.FAILED,
      CANCELLED: MediaTaskStatus.FAILED,
    };

    const known = Object.hasOwn(statusMap, data?.status);
    const status = known ? statusMap[data.status] : MediaTaskStatus.FAILED;
    const result: MediaTaskResult = {
      taskId,
      status,
      progress: data.progress ? Math.round(data.progress * 100) : undefined,
      provider: this.id,
    };

    const outputUrl = Array.isArray(data.output) ? data.output[0] : data.output;
    if (status === MediaTaskStatus.COMPLETED && outputUrl) {
      const videoUrl = outputUrl;
      result.result = {
        url: videoUrl,
        mediaType: MediaType.VIDEO,
        duration: data.options?.duration ?? 5,
        cost: this.estimateCost(data.options?.model, data.options?.duration),
        provider: this.id,
        model: data.options?.model ?? 'gen3a_turbo',
        durationMs: 0,
      };
    }

    if (!known) {
      result.error = `Runway 返回未知任务状态: ${String(data?.status)}`;
    } else if (status === MediaTaskStatus.FAILED) {
      result.error = data.failure ?? data.failureCode ?? '视频生成失败';
    }

    return result;
  }

  getModels(): MediaModelInfo[] {
    return [
      {
        id: 'gen3a_turbo',
        name: 'Gen-3 Alpha Turbo',
        mediaType: MediaType.VIDEO,
        maxWidth: 1280,
        maxHeight: 768,
        maxDuration: 10,
        supportedFormats: ['mp4'],
      },
      {
        id: 'gen4_turbo',
        name: 'Gen-4 Turbo',
        mediaType: MediaType.VIDEO,
        maxWidth: 1920,
        maxHeight: 1080,
        maxDuration: 10,
        supportedFormats: ['mp4'],
      },
    ];
  }

  private resolveRatio(resolution?: string): string {
    if (!resolution) return '16:9';
    const [w, h] = resolution.split('x').map(Number);
    if (!w || !h) return '16:9';
    const ratio = w / h;
    if (ratio >= 1.7) return '16:9';
    if (ratio >= 0.9) return '1:1';
    return '9:16';
  }

  private estimateCost(model?: string, duration?: number): number {
    const seconds = duration ?? 5;
    // Gen-3 Alpha Turbo: ~$0.05/s, Gen-4: ~$0.10/s
    const perSecond = model === 'gen4_turbo' ? 0.1 : 0.05;
    return seconds * perSecond;
  }
}
