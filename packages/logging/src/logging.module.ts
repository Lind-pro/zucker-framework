import { Module, DynamicModule, Global, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AccessLoggerInterceptor } from './access-logger.interceptor';
import { CorrelationIdMiddleware } from './correlation-id';
import { BusinessLogger } from './business-logger';
import { StructuredLogger } from './structured-logger';

@Global()
@Module({})
export class ZuckerLoggingModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
  }

  static forRoot(): DynamicModule {
    return {
      module: ZuckerLoggingModule,
      // 关键：@Global() 装饰器只让本模块的 _static_ providers 全局可见；
      // dynamic forRoot 返回的 providers 必须显式 global: true 才会被加入 GlobalsContainer，
      // 否则上层依赖（如 APP_INTERCEPTOR 解析 Reflector）会在子模块 scope 找不到。
      global: true,
      providers: [
        { provide: APP_INTERCEPTOR, useClass: AccessLoggerInterceptor },
        BusinessLogger,
        { provide: StructuredLogger, useValue: new StructuredLogger() },
      ],
      exports: [BusinessLogger, StructuredLogger],
    };
  }
}
