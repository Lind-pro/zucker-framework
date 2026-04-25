import { Injectable, Logger } from '@nestjs/common';
import { NotFoundException } from '@zucker/core';
import { AICallWrapper } from './call-wrapper';
import { CostTracker } from './cost-tracker';
import { MediaProviderManager } from './media-provider-manager';
import type {
  MediaGenerationConfig,
  MediaGenerationResult,
  MediaTaskResult,
} from './media.interface';
import { MediaTaskStatus, MediaType } from './media.interface';

/** 图片生成选项 */
export interface ImageGenerationOptions {
  /** 指定 provider（不指定则使用默认） */
  provider?: string;
  /** 模型 ID */
  modelId?: string;
  /** 图片宽度 */
  width?: number;
  /** 图片高度 */
  height?: number;
  /** 质量 */
  quality?: 'standard' | 'hd';
  /** 风格 */
  style?: 'natural' | 'vivid';
  /** 输出格式 */
  format?: 'png' | 'jpeg' | 'webp';
  /** 生成数量 */
  count?: number;
  /** 负面提示词 */
  negativePrompt?: string;
  /** 参考图片 URL */
  referenceImageUrl?: string;
  /** 图生图强度 */
  imageStrength?: number;
  /** 随机种子 */
  seed?: number;
  /** 超时 (ms) */
  timeoutMs?: number;
  /** 用户 ID（用于计费追踪） */
  userId?: string;
}

/** 视频生成选项 */
export interface VideoGenerationOptions {
  /** 指定 provider */
  provider?: string;
  /** 模型 ID */
  modelId?: string;
  /** 视频时长 (秒) */
  duration?: number;
  /** 分辨率 */
  resolution?: string;
  /** 首帧图片 URL */
  firstFrameUrl?: string;
  /** 末帧图片 URL */
  lastFrameUrl?: string;
  /** 运镜模式 */
  cameraMotion?: string;
  /** 超时 (ms) */
  timeoutMs?: number;
  /** 用户 ID */
  userId?: string;
}

/**
 * 媒体生成服务
 * 统一的图片/视频生成入口，集成重试和计费
 */
@Injectable()
export class MediaGenerationService {
  private readonly logger = new Logger(MediaGenerationService.name);

  constructor(
    private readonly providerManager: MediaProviderManager,
    private readonly callWrapper: AICallWrapper,
    private readonly costTracker: CostTracker,
  ) {}

  /**
   * 生成图片
   */
  async generateImage(
    prompt: string,
    apiKey: string,
    options: ImageGenerationOptions = {},
  ): Promise<MediaGenerationResult> {
    const provider = this.resolveProvider(options.provider, MediaType.IMAGE);
    const config = this.buildConfig(apiKey, options);

    const startTime = Date.now();
    const result = await this.callWrapper.callWithRetry(
      () => provider.generate(prompt, config),
      {
        timeoutMs: options.timeoutMs ?? 120_000,
        maxAttempts: 2,
        context: `图片生成 [${provider.id}]`,
      },
    );

    const durationMs = Date.now() - startTime;

    // 同步返回的直接结果
    if (this.isGenerationResult(result)) {
      result.durationMs = durationMs;
      this.trackCost(result, options.userId);
      return result;
    }

    // 异步任务 — 处理各种状态
    if (result.status === MediaTaskStatus.FAILED) {
      throw new Error(`图片生成失败: ${result.error ?? '未知错误'}`);
    }

    if (result.status === MediaTaskStatus.COMPLETED && result.result) {
      result.result.durationMs = durationMs;
      this.trackCost(result.result, options.userId);
      return result.result;
    }

    throw new Error(
      `图片生成返回异步任务 (taskId=${result.taskId})，请使用 getTaskStatus 查询`,
    );
  }

  /**
   * 生成视频（通常为异步，返回任务信息）
   */
  async generateVideo(
    prompt: string,
    apiKey: string,
    options: VideoGenerationOptions = {},
  ): Promise<MediaGenerationResult | MediaTaskResult> {
    const provider = this.resolveProvider(options.provider, MediaType.VIDEO);
    const config: MediaGenerationConfig = {
      apiKey,
      modelId: options.modelId ?? provider.getModels()[0]?.id ?? '',
      timeoutMs: options.timeoutMs ?? 300_000,
      duration: options.duration,
      resolution: options.resolution,
      firstFrameUrl: options.firstFrameUrl,
      lastFrameUrl: options.lastFrameUrl,
      cameraMotion: options.cameraMotion,
    };

    const startTime = Date.now();
    const result = await this.callWrapper.callWithRetry(
      () => provider.generate(prompt, config),
      {
        timeoutMs: options.timeoutMs ?? 300_000,
        maxAttempts: 2,
        context: `视频生成 [${provider.id}]`,
      },
    );

    const durationMs = Date.now() - startTime;

    if (this.isGenerationResult(result)) {
      result.durationMs = durationMs;
      this.trackCost(result, options.userId);
      return result;
    }

    // 视频通常返回异步任务
    return result;
  }

  /**
   * 查询异步任务状态
   * @param extra 额外配置（如 firstFrameUrl 用于 Kling 区分端点）
   */
  async getTaskStatus(
    providerId: string,
    taskId: string,
    apiKey: string,
    extra?: Partial<MediaGenerationConfig>,
  ): Promise<MediaTaskResult> {
    const provider = this.providerManager.get(providerId);
    if (!provider.getTaskStatus) {
      throw new Error(`Provider '${providerId}' 不支持异步任务查询`);
    }
    return provider.getTaskStatus(taskId, {
      apiKey,
      modelId: '',
      ...extra,
    } as MediaGenerationConfig);
  }

  /** 解析 provider：优先用户指定 → 按类型筛选首个 → 默认 */
  private resolveProvider(providerId: string | undefined, type: MediaType) {
    if (providerId) {
      const provider = this.providerManager.get(providerId);
      if (!provider.supportedTypes.includes(type)) {
        throw new Error(
          `Provider '${providerId}' 不支持 ${type} (支持: ${provider.supportedTypes.join(', ')})`,
        );
      }
      return provider;
    }

    const byType = this.providerManager.getByMediaType(type);
    if (byType.length > 0) {
      return byType[0];
    }

    throw new NotFoundException(
      `没有支持 ${type} 的 MediaProvider，请先注册`,
    );
  }

  /** 构建配置 */
  private buildConfig(
    apiKey: string,
    options: ImageGenerationOptions,
  ): MediaGenerationConfig {
    return {
      apiKey,
      modelId: options.modelId ?? '',
      timeoutMs: options.timeoutMs,
      width: options.width,
      height: options.height,
      quality: options.quality,
      style: options.style,
      format: options.format,
      count: options.count,
      negativePrompt: options.negativePrompt,
      referenceImageUrl: options.referenceImageUrl,
      imageStrength: options.imageStrength,
      seed: options.seed,
    };
  }

  /** 记录费用 */
  private trackCost(result: MediaGenerationResult, userId?: string): void {
    this.costTracker.record({
      timestamp: Date.now(),
      provider: result.provider,
      model: result.model,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cost: result.cost,
      userId,
      scenario: `media:${result.mediaType.toLowerCase()}`,
      duration: result.durationMs,
    });
  }

  /** 类型守卫：区分同步结果和异步任务 */
  private isGenerationResult(
    result: MediaGenerationResult | MediaTaskResult,
  ): result is MediaGenerationResult {
    return 'mediaType' in result && !('taskId' in result);
  }
}
