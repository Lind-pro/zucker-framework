/**
 * Buffer 配置
 *
 * 对齐 jetlinks BufferSettings：
 * - filePath / fileName 用于文件队列持久化
 * - retryWhenError 谓词控制是否重试
 * - parallelism 基于 CPU 核数的默认值
 */
export interface BufferSettings {
  /** 缓冲区大小，超过后自动刷新，默认 1000 */
  bufferSize: number;
  /** 刷新超时时间（毫秒），默认 2000 */
  flushTimeoutMs: number;
  /** 最大重试次数，默认 5（对齐 jetlinks 默认值） */
  maxRetries: number;
  /** 并行度，默认 CPU/2（对齐 jetlinks） */
  parallelism: number;
  /** 文件队列目录，用于内存溢出时持久化 */
  fileQueueDir?: string;
  /** 错误重试判断谓词，返回 true 表示应重试 */
  retryWhenError?: (error: unknown) => boolean;
  /** Buffer 名称，用于日志和指标 */
  name?: string;
}

/** 默认重试判断：网络/IO 相关错误可重试 */
export const defaultRetryWhenError = (error: unknown): boolean => {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return (
      msg.includes('timeout') ||
      msg.includes('econnrefused') ||
      msg.includes('econnreset') ||
      msg.includes('epipe') ||
      msg.includes('network') ||
      msg.includes('unavailable') ||
      msg.includes('deadlock')
    );
  }
  return false;
};

/** 获取默认 parallelism（CPU 核数的一半，最少 1） */
function getDefaultParallelism(): number {
  try {
    const os = require('node:os');
    return Math.max(1, Math.floor(os.cpus().length / 2));
  } catch {
    return 1;
  }
}

export const DEFAULT_BUFFER_SETTINGS: BufferSettings = {
  bufferSize: 1000,
  flushTimeoutMs: 2000,
  maxRetries: 5,
  parallelism: getDefaultParallelism(),
  retryWhenError: defaultRetryWhenError,
};

/**
 * 缓冲条目接口 — 对应 jetlinks Buffered<T>
 * 允许 handler 对每个条目标记重试或死信
 */
export interface Buffered<T> {
  /** 原始数据 */
  readonly data: T;
  /** 当前重试次数 */
  readonly retryTimes: number;
  /** 标记此条目需要重试 */
  retry(shouldRetry?: boolean): void;
  /** 标记此条目进入死信队列 */
  dead(): void;
}

/**
 * 刷新上下文 — 对应 jetlinks FlushContext<T>
 * handler 可以通过此接口报告错误
 */
export interface FlushContext<T> {
  /** 报告错误信息 */
  error(err: Error): void;
  /** 本批次的缓冲条目列表 */
  readonly items: ReadonlyArray<Buffered<T>>;
  /** 本批次大小 */
  readonly size: number;
}

/**
 * 内存使用估算接口 — 对应 jetlinks MemoryUsage
 * 实现此接口的数据类型可以提供精确的内存占用估算
 */
export interface MemoryUsage {
  /** 返回估算的字节数 */
  usage(): number;
}
