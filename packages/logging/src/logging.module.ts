import {
  RejectedRequestLoggerMiddleware,
  REJECTED_REQUEST_LOG_OPTIONS,
  type RejectedRequestLogOptions,
} from './rejected-request-logger.middleware';
import {
  Module,
  DynamicModule,
  Global,
  MiddlewareConsumer,
  NestModule,
  Inject,
  Optional,
} from '@nestjs/common';
import { APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import {
  AccessLoggerInterceptor,
  ACCESS_LOG_CAPTURE_OPTIONS,
  type AccessLogCaptureOptions,
} from './access-logger.interceptor';
import {
  CorrelationIdMiddleware,
  CORRELATION_ID_OPTIONS,
  type CorrelationIdOptions,
} from './correlation-id';
import { BusinessLogger } from './business-logger';
import { StructuredLogger } from './structured-logger';
import { PiiFilter, type PiiFilterOptions } from './pii-filter';
import { LogSanitizer } from './log-sanitizer';
import {
  AccessLogService,
  OperationLogService,
  PERSISTENT_LOG_OPTIONS,
  type PersistentLogOptions,
} from './persistent-logs';

export interface ZuckerLoggingOptions extends AccessLogCaptureOptions {
  pii?: PiiFilterOptions;
  /** Disable when the host already establishes the shared correlation context. */
  correlationId?: boolean | CorrelationIdOptions;
  /** Requires the host's configured DATABASE_ADAPTER. Omit for event-only logging. */
  persistence?: PersistentLogOptions;
  /** Capture 4xx/5xx responses even when no controller action runs. Requires persistence. */
  rejectedRequests?: Omit<RejectedRequestLogOptions, 'retainClientIp'>;
}
const LOGGING_OPTIONS = Symbol('LOGGING_OPTIONS');

@Global()
@Module({})
export class ZuckerLoggingModule implements NestModule {
  constructor(
    @Optional() @Inject(LOGGING_OPTIONS) private readonly options: ZuckerLoggingOptions = {},
  ) {}
  configure(consumer: MiddlewareConsumer): void {
    if (this.options.correlationId !== false)
      consumer.apply(CorrelationIdMiddleware).forRoutes('{*path}');
    if (this.options.rejectedRequests)
      consumer.apply(RejectedRequestLoggerMiddleware).forRoutes('{*path}');
  }

  static forRoot(options: ZuckerLoggingOptions = {}): DynamicModule {
    if (options.rejectedRequests && !options.persistence)
      throw new Error('Rejected request logging requires persistence');
    return {
      module: ZuckerLoggingModule,
      // 关键：@Global() 装饰器只让本模块的 _static_ providers 全局可见；
      // dynamic forRoot 返回的 providers 必须显式 global: true 才会被加入 GlobalsContainer，
      // 否则上层依赖（如 APP_INTERCEPTOR 解析 Reflector）会在子模块 scope 找不到。
      global: true,
      providers: [
        { provide: LOGGING_OPTIONS, useValue: options },
        {
          provide: CORRELATION_ID_OPTIONS,
          useValue: typeof options.correlationId === 'object' ? options.correlationId : {},
        },
        Reflector,
        ...(options.rejectedRequests
          ? [
              {
                provide: REJECTED_REQUEST_LOG_OPTIONS,
                useValue: { ...options.rejectedRequests, retainClientIp: options.retainClientIp },
              },
              RejectedRequestLoggerMiddleware,
            ]
          : []),
        { provide: PiiFilter, useFactory: () => new PiiFilter(options.pii) },
        { provide: LogSanitizer, useFactory: () => new LogSanitizer(options.pii) },
        {
          provide: ACCESS_LOG_CAPTURE_OPTIONS,
          useValue: { retainClientIp: options.retainClientIp },
        },
        ...(options.persistence
          ? [
              { provide: PERSISTENT_LOG_OPTIONS, useValue: options.persistence },
              AccessLogService,
              OperationLogService,
            ]
          : []),
        { provide: APP_INTERCEPTOR, useClass: AccessLoggerInterceptor },
        BusinessLogger,
        {
          provide: StructuredLogger,
          useFactory: (piiFilter: PiiFilter) =>
            new StructuredLogger(undefined, undefined, piiFilter),
          inject: [PiiFilter],
        },
      ],
      exports: [
        BusinessLogger,
        StructuredLogger,
        PiiFilter,
        LogSanitizer,
        ...(options.persistence ? [AccessLogService, OperationLogService] : []),
      ],
    };
  }
}
