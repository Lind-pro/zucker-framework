/**
 * 媒体生成相关接口定义
 * 支持图片、视频、音频等多媒体 AI 生成
 */

/** 媒体类型 */
export enum MediaType {
  IMAGE = 'IMAGE',
  VIDEO = 'VIDEO',
  AUDIO = 'AUDIO',
}

/** 媒体生成配置 */
export interface MediaGenerationConfig {
  /** API 密钥 */
  apiKey: string;
  /** 自定义端点 */
  baseURL?: string;
  /** 模型标识 */
  modelId: string;
  /** 请求超时 (ms) */
  timeoutMs?: number;
  /** 代理地址 */
  proxyUrl?: string;

  // ---- 图片参数 ----
  /** 图片宽度 */
  width?: number;
  /** 图片高度 */
  height?: number;
  /** 图片质量：standard | hd */
  quality?: 'standard' | 'hd';
  /** 风格：natural | vivid */
  style?: 'natural' | 'vivid';
  /** 输出格式 */
  format?: 'png' | 'jpeg' | 'webp';
  /** 生成数量 */
  count?: number;
  /** 参考图片 URL（图生图） */
  referenceImageUrl?: string;
  /** 图生图强度 (0-1)，越高越偏离原图 */
  imageStrength?: number;
  /** 负面提示词 */
  negativePrompt?: string;
  /** CFG Scale (Classifier Free Guidance) */
  cfgScale?: number;
  /** 随机种子 */
  seed?: number;
  /** 采样步数 */
  steps?: number;

  // ---- 视频参数 ----
  /** 视频时长 (秒) */
  duration?: number;
  /** 帧率 */
  fps?: number;
  /** 视频分辨率，如 '1280x720' */
  resolution?: string;
  /** 首帧图片 URL */
  firstFrameUrl?: string;
  /** 末帧图片 URL */
  lastFrameUrl?: string;
  /** 运镜模式 */
  cameraMotion?: string;
}

/** 媒体生成结果 */
export interface MediaGenerationResult {
  /** 媒体访问 URL */
  url?: string;
  /** Base64 编码的媒体数据 */
  base64?: string;
  /** 媒体类型 */
  mediaType: MediaType;
  /** 宽度 */
  width?: number;
  /** 高度 */
  height?: number;
  /** 视频/音频时长 (秒) */
  duration?: number;
  /** 文件格式 */
  format?: string;
  /** 文件大小 (bytes) */
  fileSize?: number;
  /** 费用 (USD) */
  cost: number;
  /** 使用的 provider */
  provider: string;
  /** 使用的模型 */
  model: string;
  /** 耗时 (ms) */
  durationMs: number;
  /** 修改后的提示词（部分 API 会返回） */
  revisedPrompt?: string;
}

/** 异步任务状态 */
export enum MediaTaskStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
}

/** 异步媒体生成任务 */
export interface MediaTaskResult {
  /** 任务 ID */
  taskId: string;
  /** 任务状态 */
  status: MediaTaskStatus;
  /** 进度 (0-100) */
  progress?: number;
  /** 生成结果（完成时） */
  result?: MediaGenerationResult;
  /** 错误信息（失败时） */
  error?: string;
  /** Provider */
  provider: string;
}

/** 媒体模型信息 */
export interface MediaModelInfo {
  id: string;
  name: string;
  mediaType: MediaType;
  maxWidth?: number;
  maxHeight?: number;
  maxDuration?: number;
  supportedFormats?: string[];
}

/**
 * 媒体生成 Provider 接口
 * 所有图片/视频/音频生成 provider 均需实现此接口
 */
export interface MediaProvider {
  /** Provider 唯一标识 */
  id: string;
  /** Provider 显示名称 */
  name: string;
  /** 支持的媒体类型 */
  supportedTypes: MediaType[];

  /**
   * 生成媒体（同步模式）
   * 对于耗时较长的任务（如视频），可能返回 MediaTaskResult
   */
  generate(
    prompt: string,
    config: MediaGenerationConfig,
  ): Promise<MediaGenerationResult | MediaTaskResult>;

  /**
   * 查询异步任务状态（视频等异步生成使用）
   * 不支持异步的 provider 可不实现
   */
  getTaskStatus?(taskId: string, config: MediaGenerationConfig): Promise<MediaTaskResult>;

  /** 获取此 provider 支持的模型列表 */
  getModels(): MediaModelInfo[];
}
