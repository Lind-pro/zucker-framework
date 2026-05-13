import {
  Module,
  DynamicModule,
  Global,
  type Provider,
  type Type,
  type InjectionToken,
  type OptionalFactoryDependency,
} from '@nestjs/common';
import { QUEUE_PROVIDER, type QueueProvider } from './queue.interface';
import { InMemoryQueue } from './in-memory-queue';
import { QueueService } from './queue.service';

export interface QueueModuleOptions {
  /** 自定义 QueueProvider 实例；缺省使用 InMemoryQueue */
  provider?: QueueProvider;
}

export interface QueueModuleAsyncOptions {
  imports?: Array<Type | DynamicModule>;
  useFactory?: (...args: unknown[]) => QueueModuleOptions | Promise<QueueModuleOptions>;
  useClass?: Type<QueueModuleOptionsFactory>;
  useExisting?: Type<QueueModuleOptionsFactory>;
  inject?: Array<InjectionToken | OptionalFactoryDependency>;
}

export interface QueueModuleOptionsFactory {
  createQueueOptions(): QueueModuleOptions | Promise<QueueModuleOptions>;
}

const QUEUE_MODULE_OPTIONS = Symbol('QUEUE_MODULE_OPTIONS');

@Global()
@Module({})
export class ZuckerQueueModule {
  static forRoot(options: QueueModuleOptions = {}): DynamicModule {
    return {
      module: ZuckerQueueModule,
      global: true,
      providers: [
        {
          provide: QUEUE_PROVIDER,
          useFactory: (): QueueProvider => options.provider ?? new InMemoryQueue(),
        },
        QueueService,
      ],
      exports: [QUEUE_PROVIDER, QueueService],
    };
  }

  static forRootAsync(options: QueueModuleAsyncOptions): DynamicModule {
    const asyncProviders = this.createAsyncProviders(options);
    return {
      module: ZuckerQueueModule,
      global: true,
      imports: options.imports ?? [],
      providers: [
        ...asyncProviders,
        {
          provide: QUEUE_PROVIDER,
          useFactory: (opts: QueueModuleOptions): QueueProvider =>
            opts.provider ?? new InMemoryQueue(),
          inject: [QUEUE_MODULE_OPTIONS],
        },
        QueueService,
      ],
      exports: [QUEUE_PROVIDER, QueueService],
    };
  }

  private static createAsyncProviders(options: QueueModuleAsyncOptions): Provider[] {
    if (options.useFactory) {
      return [
        {
          provide: QUEUE_MODULE_OPTIONS,
          useFactory: options.useFactory,
          inject: options.inject ?? [],
        },
      ];
    }
    const optionsProvider: Provider = {
      provide: QUEUE_MODULE_OPTIONS,
      useFactory: async (factory: QueueModuleOptionsFactory) => factory.createQueueOptions(),
      inject: [options.useClass ?? options.useExisting!],
    };
    if (options.useClass) {
      return [{ provide: options.useClass, useClass: options.useClass }, optionsProvider];
    }
    return [optionsProvider];
  }
}
