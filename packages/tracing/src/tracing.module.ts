import { Module, Global, DynamicModule, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { InMemoryTracer, RatioSampler, ParentBasedSampler } from './tracer';
import { TraceInterceptor } from './trace-interceptor';
import { TraceMiddleware } from './trace-middleware';

export interface TracingModuleOptions {
  /** 采样比率 (0.0 - 1.0)，默认 1.0 */
  sampleRate?: number;
}

@Global()
@Module({})
export class ZuckerTracingModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TraceMiddleware).forRoutes('*');
  }

  static forRoot(options?: TracingModuleOptions): DynamicModule {
    const sampleRate = options?.sampleRate ?? 1.0;

    return {
      module: ZuckerTracingModule,
      providers: [
        {
          provide: InMemoryTracer,
          useFactory: () => {
            const sampler = new ParentBasedSampler(new RatioSampler(sampleRate));
            return new InMemoryTracer(sampler);
          },
        },
        { provide: APP_INTERCEPTOR, useClass: TraceInterceptor },
      ],
      exports: [InMemoryTracer],
    };
  }
}
