import { Injectable, Inject, Optional, Logger } from '@nestjs/common';
// The CommonJS default is the original EventEmitter2 constructor in both formats.
import EventEmitter2Constructor, { type EventEmitter2 } from 'eventemitter2';
import { getCorrelationId } from './correlation-id';
import { PiiFilter } from './pii-filter';

export const BUSINESS_LOGGER_BUS = Symbol('BUSINESS_LOGGER_BUS');
export const BUSINESS_LOG_EVENT = 'zucker.business-log';

export interface BusinessLogEntry {
  module: string;
  action: string;
  level: 'INFO' | 'WARN' | 'ERROR';
  target?: string;
  targetType?: string;
  detail?: string;
  userId?: string;
  correlationId?: string;
  metadata?: Record<string, unknown>;
  timestamp: string;
}

export interface BusinessLogBus {
  publish(topic: string, payload: unknown): Promise<void>;
}

/**
 * 业务操作日志器 — 区别于 HTTP 访问日志，用于记录业务操作
 *
 * 支持两种输出方式：
 * 1. 通过 EventEmitter2 本地事件（始终可用）
 * 2. 通过可选的 BusinessLogBus 远程总线
 */
@Injectable()
export class BusinessLogger {
  private readonly logger = new Logger(BusinessLogger.name);
  private readonly piiFilter = new PiiFilter();

  constructor(
    @Optional() @Inject(EventEmitter2Constructor) private readonly eventEmitter?: EventEmitter2,
    @Optional()
    @Inject(BUSINESS_LOGGER_BUS)
    private readonly bus?: BusinessLogBus,
  ) {}

  /**
   * 记录业务操作日志
   */
  async logOperation(
    module: string,
    action: string,
    target?: string,
    detail?: string,
    userId?: string,
  ): Promise<void> {
    await this.log({
      module,
      action,
      level: 'INFO',
      target,
      detail,
      userId,
    });
  }

  /**
   * 记录业务告警
   */
  async logWarning(
    module: string,
    action: string,
    detail: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    await this.log({
      module,
      action,
      level: 'WARN',
      detail,
      metadata,
    });
  }

  /**
   * 记录业务错误
   */
  async logError(
    module: string,
    action: string,
    detail: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    await this.log({
      module,
      action,
      level: 'ERROR',
      detail,
      metadata,
    });
  }

  /**
   * 完整日志记录
   */
  async log(params: Omit<BusinessLogEntry, 'correlationId' | 'timestamp'>): Promise<void> {
    const entry = this.piiFilter.sanitizeValue({
      ...params,
      correlationId: getCorrelationId(),
      timestamp: new Date().toISOString(),
    }) as BusinessLogEntry;

    // 始终通过事件总线发布
    this.eventEmitter?.emit(BUSINESS_LOG_EVENT, entry);

    // 通过远程总线发布（如果可用）
    if (this.bus) {
      try {
        await this.bus.publish('system/business-log', entry);
      } catch (err) {
        this.logger.warn(
          this.piiFilter.sanitize(
            `Failed to publish business log via bus: ${
              err instanceof Error ? err.message : String(err)
            }`,
          ),
        );
      }
    }
  }
}
