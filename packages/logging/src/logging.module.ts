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
      providers: [
        { provide: APP_INTERCEPTOR, useClass: AccessLoggerInterceptor },
        BusinessLogger,
        { provide: StructuredLogger, useValue: new StructuredLogger() },
      ],
      exports: [BusinessLogger, StructuredLogger],
    };
  }
}
