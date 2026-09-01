import { Injectable, Logger } from '@nestjs/common';
import type { AICallObserver, AICallSuccessEvent, AICallErrorEvent } from '../call-observer';
import { summarizeAIResult } from './result-summarizer';

/**
 * 业务侧 OperationLog 表/服务的最小接口。框架只描述需要的字段，
 * 不绑定具体 schema。业务侧只需把已有的 `OperationLogService` 包成这个接口
 * （5 行 adapter）即可。
 */
export interface OperationLogSink {
  log(data: OperationLogEntry): Promise<void>;
}

export interface OperationLogEntry {
  module: string;
  action: string;
  status: 'SUCCESS' | 'FAILED';
  durationMs: number;
  userId?: string;
  targetId?: string;
  targetType?: string;
  method?: string;
  path?: string;
  requestData?: Record<string, unknown>;
  responseData?: Record<string, unknown>;
  errorMessage?: string;
  metadata?: Record<string, unknown>;
}

export interface PrismaOperationLogObserverOptions {
  /** 日志的 module 字段（默认 `'ai'`） */
  module?: string;
  /** request 路径（默认 `'/v1/chat/completions'`） */
  path?: string;
  /** 从 metadata 提取 userId 的 key 名（默认 `'userId'`） */
  userIdKey?: string;
  /** 从 metadata 提取 targetId 的 key 名（默认 `'targetId'`） */
  targetIdKey?: string;
  /** targetType 字段（默认 `'AIRequest'`） */
  targetType?: string;
  /** content preview 截断长度（传给 summarizer） */
  previewMax?: number;
}

/**
 * 把 AI 调用 success/error 事件写入业务侧 OperationLog 的 observer。
 *
 * 替代每个项目自己写一份 ~100 行的 observer，业务侧仅需提供：
 * 1. 一个 `OperationLogSink` 实现（包装现有 OperationLogService）
 * 2. 可选 options 调整字段映射
 *
 * @example
 * ```ts
 * const observer = new PrismaOperationLogObserver(
 *   { log: (entry) => myOpLogService.log({ ...entry, status: prismaEnum(entry.status) }) },
 *   { userIdKey: 'userId', targetIdKey: 'dossierId' },
 * );
 * registry.register(observer);
 * ```
 */
@Injectable()
export class PrismaOperationLogObserver implements AICallObserver {
  private readonly logger = new Logger(PrismaOperationLogObserver.name);
  private readonly options: Required<PrismaOperationLogObserverOptions>;

  constructor(
    private readonly sink: OperationLogSink,
    options: PrismaOperationLogObserverOptions = {},
  ) {
    this.options = {
      module: options.module ?? 'ai',
      path: options.path ?? '/v1/chat/completions',
      userIdKey: options.userIdKey ?? 'userId',
      targetIdKey: options.targetIdKey ?? 'targetId',
      targetType: options.targetType ?? 'AIRequest',
      previewMax: options.previewMax ?? 200,
    };
  }

  async onSuccess(event: AICallSuccessEvent): Promise<void> {
    try {
      const entry = this.buildEntry(event, 'SUCCESS');
      const summary = summarizeAIResult(event.result, { previewMax: this.options.previewMax });
      entry.responseData = summary as unknown as Record<string, unknown>;
      await this.sink.log(entry);
    } catch (e) {
      this.logger.warn(
        `记录 AI 成功日志失败: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  async onError(event: AICallErrorEvent): Promise<void> {
    try {
      const entry = this.buildEntry(event, 'FAILED');
      entry.errorMessage = event.error.message;
      await this.sink.log(entry);
    } catch (e) {
      this.logger.warn(
        `记录 AI 失败日志失败: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  private buildEntry(
    event: AICallSuccessEvent | AICallErrorEvent,
    status: 'SUCCESS' | 'FAILED',
  ): OperationLogEntry {
    const meta = event.metadata ?? {};
    const userId = meta[this.options.userIdKey];
    const targetId = meta[this.options.targetIdKey];
    return {
      module: this.options.module,
      action: event.context,
      status,
      durationMs: event.durationMs,
      userId: typeof userId === 'string' ? userId : undefined,
      targetId: typeof targetId === 'string' ? targetId : undefined,
      targetType: this.options.targetType,
      method: 'POST',
      path: this.options.path,
      requestData: this.normalizeRequestData(meta),
      metadata: { ...meta, attempt: event.attempt },
    };
  }

  private normalizeRequestData(metadata: Record<string, unknown>): Record<string, unknown> | undefined {
    const req = metadata.requestData;
    if (req && typeof req === 'object') return req as Record<string, unknown>;
    return undefined;
  }
}
