import { Module, DynamicModule, Global, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { AccessLoggerInterceptor } from './access-logger.interceptor';
import { CorrelationIdMiddleware } from './correlation-id';
import { BusinessLogger } from './business-logger';
import { StructuredLogger } from './structured-logger';
import { PiiFilter } from './pii-filter';

@Global()
@Module({})
export class ZuckerLoggingModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Nest 11 uses path-to-regexp v8. The named wildcard keeps the middleware
    // global without triggering LegacyRouteConverter on every application boot.
    consumer.apply(CorrelationIdMiddleware).forRoutes('{*path}');
  }

  static forRoot(): DynamicModule {
    return {
      module: ZuckerLoggingModule,
      // 关键：@Global() 装饰器只让本模块的 _static_ providers 全局可见；
      // dynamic forRoot 返回的 providers 必须显式 global: true 才会被加入 GlobalsContainer，
      // 否则上层依赖（如 APP_INTERCEPTOR 解析 Reflector）会在子模块 scope 找不到。
      global: true,
      providers: [
        Reflector,
        PiiFilter,
        { provide: APP_INTERCEPTOR, useClass: AccessLoggerInterceptor },
        BusinessLogger,
        {
          provide: StructuredLogger,
          useFactory: (piiFilter: PiiFilter) =>
            new StructuredLogger(undefined, undefined, piiFilter),
          inject: [PiiFilter],
        },
      ],
      exports: [BusinessLogger, StructuredLogger, PiiFilter],
    };
  }
}
