import { LoggerService } from '@nestjs/common';
import { getCorrelationId } from './correlation-id';
import { PiiFilter } from './pii-filter';

export enum LogLevel {
  DEBUG = 'DEBUG',
  INFO = 'INFO',
  WARN = 'WARN',
  ERROR = 'ERROR',
}

export interface StructuredLogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  correlationId?: string;
  traceId?: string;
  spanId?: string;
  module?: string;
  data?: Record<string, unknown>;
}

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  [LogLevel.DEBUG]: 0,
  [LogLevel.INFO]: 1,
  [LogLevel.WARN]: 2,
  [LogLevel.ERROR]: 3,
};

/**
 * traceId 解析器 — 允许 @zucker/tracing 注入 getTraceId/getSpanId，
 * 避免 logging 包直接依赖 tracing 包
 */
let traceIdResolver: (() => string | undefined) | undefined;
let spanIdResolver: (() => string | undefined) | undefined;

/**
 * 注册 traceId 解析器（由 @zucker/tracing 调用）
 */
export function registerTraceIdResolver(
  getTraceId: () => string | undefined,
  getSpanId?: () => string | undefined,
): void {
  traceIdResolver = getTraceId;
  spanIdResolver = getSpanId;
}

/**
 * 结构化日志器 — 输出 JSON 格式日志，自动注入 correlationId 和 traceId
 */
export class StructuredLogger implements LoggerService {
  private minLevel: LogLevel;
  /** 日志采样率 (0.0 - 1.0)，对 DEBUG 级别生效 */
  private debugSampleRate = 1.0;
  private readonly piiFilter: PiiFilter;

  constructor(
    private readonly module?: string,
    minLevel: LogLevel = LogLevel.DEBUG,
    piiFilter?: PiiFilter,
  ) {
    this.minLevel = minLevel;
    this.piiFilter = piiFilter ?? new PiiFilter();
  }

  setMinLevel(level: LogLevel): void {
    this.minLevel = level;
  }

  setDebugSampleRate(rate: number): void {
    this.debugSampleRate = Math.max(0, Math.min(1, rate));
  }

  log(message: string, context?: string): void {
    this.writeLog(LogLevel.INFO, message, context);
  }

  warn(message: string, context?: string): void {
    this.writeLog(LogLevel.WARN, message, context);
  }

  error(message: string, trace?: string, context?: string): void {
    this.writeLog(LogLevel.ERROR, message, context, trace ? { trace } : undefined);
  }

  debug(message: string, context?: string): void {
    this.writeLog(LogLevel.DEBUG, message, context);
  }

  verbose(message: string, context?: string): void {
    this.writeLog(LogLevel.DEBUG, message, context);
  }

  /**
   * 写入结构化日志
   */
  writeLog(
    level: LogLevel,
    message: string,
    module?: string,
    data?: Record<string, unknown>,
  ): void {
    if (LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[this.minLevel]) {
      return;
    }

    // DEBUG 级别采样
    if (level === LogLevel.DEBUG && this.debugSampleRate < 1.0) {
      if (Math.random() > this.debugSampleRate) return;
    }

    const entry: StructuredLogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message: this.piiFilter.sanitize(message),
      correlationId: getCorrelationId(),
      traceId: traceIdResolver?.(),
      spanId: spanIdResolver?.(),
      module: this.piiFilter.sanitize(module || this.module || ''),
      data: data ? (this.piiFilter.sanitizeValue(data) as Record<string, unknown>) : undefined,
    };

    const output = JSON.stringify(entry);

    switch (level) {
      case LogLevel.ERROR:
        process.stderr.write(output + '\n');
        break;
      case LogLevel.WARN:
        process.stderr.write(output + '\n');
        break;
      default:
        process.stdout.write(output + '\n');
        break;
    }
  }
}
