import {
  MediaTaskStatus,
  MediaType,
  type MediaProvider,
  type MediaGenerationConfig,
  type MediaGenerationResult,
  type MediaModelInfo,
  type MediaTaskResult,
} from '../media.interface';
import { providerRequestSignal } from '../abort-signal';
import { providerHttpError } from '../provider-http-error';

const KLING_API_BASE = 'https://api.klingai.com/v1';

/**
 * 可灵 (Kling) 视频/图片生成 Provider
 * 快手旗下 AI 创作平台，支持文生视频、图生视频、文生图
 * 异步模式：提交任务 → 轮询状态 → 获取结果
 */
export class KlingProvider implements MediaProvider {
  id = 'kling';
  name = '可灵 AI';
  supportedTypes = [MediaType.VIDEO, MediaType.IMAGE];

  async generate(
    prompt: string,
    config: MediaGenerationConfig,
  ): Promise<MediaGenerationResult | MediaTaskResult> {
    const baseURL = config.baseURL || KLING_API_BASE;
    const modelId = config.modelId || 'kling-v1';

    // 图片生成走同步模式
    if (this.isImageModel(modelId)) {
      return this.generateImage(prompt, config, baseURL);
    }

    // 视频生成走异步模式
    return this.generateVideo(prompt, config, baseURL);
  }

  async getTaskStatus(taskId: string, config: MediaGenerationConfig): Promise<MediaTaskResult> {
    const baseURL = config.baseURL || KLING_API_BASE;

    // 根据 firstFrameUrl 判断是图生视频还是文生视频
    const encodedTaskId = encodeURIComponent(taskId);
    const endpoint = config.firstFrameUrl
      ? `${baseURL}/videos/image2video/${encodedTaskId}`
      : `${baseURL}/videos/text2video/${encodedTaskId}`;

    const response = await fetch(endpoint, {
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      signal: providerRequestSignal(config.signal, config.timeoutMs),
    });

    if (!response.ok) {
      throw await providerHttpError('Kling', response);
    }

    const data = (await response.json()) as any;
    const taskData = data?.data;

    // Kling reports API-level errors (expired/unknown task, auth) as HTTP 200 with a
    // non-zero `code` and no `data`; treat them as terminal so pollers stop.
    if ((data?.code !== undefined && data.code !== 0) || !taskData) {
      return {
        taskId,
        status: MediaTaskStatus.FAILED,
        provider: this.id,
        error: String(data?.message ?? '可灵任务查询失败'),
      };
    }

    const statusMap: Record<string, MediaTaskStatus> = {
      submitted: MediaTaskStatus.PENDING,
      processing: MediaTaskStatus.PROCESSING,
      succeed: MediaTaskStatus.COMPLETED,
      failed: MediaTaskStatus.FAILED,
    };

    const status = Object.hasOwn(statusMap, taskData.task_status)
      ? statusMap[taskData.task_status]
      : MediaTaskStatus.FAILED;
    const result: MediaTaskResult = {
      taskId,
      status,
      provider: this.id,
    };
    if (!Object.hasOwn(statusMap, taskData.task_status)) {
      result.error = `可灵返回未知任务状态: ${String(taskData.task_status)}`;
      return result;
    }

    if (status === MediaTaskStatus.COMPLETED && taskData?.task_result?.videos?.length) {
      const video = taskData.task_result.videos[0];
      result.result = {
        url: video.url,
        mediaType: MediaType.VIDEO,
        duration: Number(video.duration) || undefined,
        width: video.width,
        height: video.height,
        cost: this.estimateCost(config.modelId, video.duration),
        provider: this.id,
        model: config.modelId || 'kling-v1',
        durationMs: 0,
      };
    }

    if (status === MediaTaskStatus.FAILED) {
      result.error = taskData?.task_status_msg ?? '视频生成失败';
    }

    return result;
  }

  getModels(): MediaModelInfo[] {
    return [
      {
        id: 'kling-v1',
        name: '可灵 1.0',
        mediaType: MediaType.VIDEO,
        maxWidth: 1920,
        maxHeight: 1080,
        maxDuration: 10,
        supportedFormats: ['mp4'],
      },
      {
        id: 'kling-v1-5',
        name: '可灵 1.5',
        mediaType: MediaType.VIDEO,
        maxWidth: 1920,
        maxHeight: 1080,
        maxDuration: 10,
        supportedFormats: ['mp4'],
      },
      {
        id: 'kling-v2',
        name: '可灵 2.0',
        mediaType: MediaType.VIDEO,
        maxWidth: 1920,
        maxHeight: 1080,
        maxDuration: 10,
        supportedFormats: ['mp4'],
      },
      {
        id: 'kolors',
        name: '可图 (Kolors)',
        mediaType: MediaType.IMAGE,
        maxWidth: 1024,
        maxHeight: 1024,
        supportedFormats: ['png', 'jpeg'],
      },
    ];
  }

  private isImageModel(modelId: string): boolean {
    return modelId === 'kolors';
  }

  private async generateImage(
    prompt: string,
    config: MediaGenerationConfig,
    baseURL: string,
  ): Promise<MediaGenerationResult> {
    const startTime = Date.now();

    const body: Record<string, unknown> = {
      model_name: config.modelId || 'kolors',
      prompt,
      n: config.count ?? 1,
    };
    if (config.negativePrompt) body.negative_prompt = config.negativePrompt;
    if (config.width) body.width = config.width;
    if (config.height) body.height = config.height;

    const response = await fetch(`${baseURL}/images/generations`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: providerRequestSignal(config.signal, config.timeoutMs),
    });

    if (!response.ok) {
      throw await providerHttpError('Kling', response);
    }

    const data = (await response.json()) as any;
    const images: unknown[] = Array.isArray(data.data?.images)
      ? data.data.images
      : Array.isArray(data.data)
        ? data.data
        : [];
    const image = images[0] as any;

    return {
      url: image?.url,
      base64: image?.b64_json,
      mediaType: MediaType.IMAGE,
      width: config.width,
      height: config.height,
      format: 'png',
      cost: 0.02 * Math.max(1, images.length || (config.count ?? 1)),
      provider: this.id,
      model: config.modelId || 'kolors',
      durationMs: Date.now() - startTime,
    };
  }

  private async generateVideo(
    prompt: string,
    config: MediaGenerationConfig,
    baseURL: string,
  ): Promise<MediaTaskResult> {
    const modelId = config.modelId || 'kling-v1';

    const body: Record<string, unknown> = {
      model_name: modelId,
      prompt,
      duration: String(config.duration ?? 5),
      cfg_scale: config.cfgScale ?? 0.5,
    };

    if (config.resolution) {
      body.aspect_ratio = this.resolveAspectRatio(config.resolution);
    }
    if (config.firstFrameUrl) {
      body.image = config.firstFrameUrl;
    }
    if (config.negativePrompt) {
      body.negative_prompt = config.negativePrompt;
    }
    if (config.cameraMotion) {
      body.camera_control = { type: config.cameraMotion };
    }

    const endpoint = config.firstFrameUrl
      ? `${baseURL}/videos/image2video`
      : `${baseURL}/videos/text2video`;

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: providerRequestSignal(config.signal, config.timeoutMs),
    });

    if (!response.ok) {
      throw await providerHttpError('Kling', response);
    }

    const data = (await response.json()) as any;
    const taskId = data.data?.task_id ?? data.request_id;

    if (!taskId) {
      throw new Error(`Kling API 未返回 task_id: ${JSON.stringify(data)}`);
    }

    return {
      taskId,
      status: MediaTaskStatus.PENDING,
      provider: this.id,
    };
  }

  private resolveAspectRatio(resolution: string): string {
    const [w, h] = resolution.split('x').map(Number);
    if (!w || !h) return '16:9';
    const ratio = w / h;
    if (ratio >= 1.7) return '16:9';
    if (ratio >= 0.9) return '1:1';
    return '9:16';
  }

  private estimateCost(modelId?: string, duration?: number): number {
    const seconds = duration ?? 5;
    switch (modelId) {
      case 'kling-v2':
        return seconds * 0.08;
      case 'kling-v1-5':
        return seconds * 0.04;
      default:
        return seconds * 0.03;
    }
  }
}
