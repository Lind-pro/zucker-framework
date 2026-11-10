import {
  Logger,
  Module,
  Global,
  type DynamicModule,
  type Provider,
  type Type,
  type InjectionToken,
  type OptionalFactoryDependency,
} from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { QUEUE_PROVIDER, type QueueProvider } from './queue.interface';
import { InMemoryQueue } from './in-memory-queue';
import { QueueService } from './queue.service';
import type { BullMqWorkerHost } from './bullmq-worker-host';
import { QUEUE_WORKER_HOST, QueueWorkerExplorer } from './queue-worker.explorer';

export interface QueueModuleOptions {
  /**
   * 自定义 QueueProvider 实例；缺省使用 InMemoryQueue。
   * InMemoryQueue 只存储任务、不消费任务，仅适用于开发/测试；生产环境未配置时会记录警告。
   */
  provider?: QueueProvider;
  /** 用于运行 `@QueueWorker` 方法的 BullMqWorkerHost；未配置时这些方法不会执行（启动时警告）。 */
  workerHost?: BullMqWorkerHost;
}

function resolveProvider(options: QueueModuleOptions): QueueProvider {
  if (options.provider) return options.provider;
  // Only a fallback warning; behaviour does not depend on the environment.
  // eslint-disable-next-line no-restricted-syntax
  if (process.env.NODE_ENV === 'production') {
    new Logger('ZuckerQueueModule').warn(
      'No queue provider configured; falling back to InMemoryQueue, which never processes jobs and is not durable. Configure BullMqQueueProvider for production.',
    );
  }
  return new InMemoryQueue();
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
      imports: [DiscoveryModule],
      providers: [
        {
          provide: QUEUE_PROVIDER,
          useFactory: (): QueueProvider => resolveProvider(options),
        },
        { provide: QUEUE_WORKER_HOST, useValue: options.workerHost ?? null },
        QueueWorkerExplorer,
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
      imports: [DiscoveryModule, ...(options.imports ?? [])],
      providers: [
        ...asyncProviders,
        {
          provide: QUEUE_PROVIDER,
          useFactory: (opts: QueueModuleOptions): QueueProvider => resolveProvider(opts),
          inject: [QUEUE_MODULE_OPTIONS],
        },
        {
          provide: QUEUE_WORKER_HOST,
          useFactory: (opts: QueueModuleOptions) => opts.workerHost ?? null,
          inject: [QUEUE_MODULE_OPTIONS],
        },
        QueueWorkerExplorer,
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
    const factoryType = options.useClass ?? options.useExisting;
    if (!factoryType) {
      throw new Error('QueueModuleAsyncOptions requires useFactory, useClass, or useExisting');
    }
    const optionsProvider: Provider = {
      provide: QUEUE_MODULE_OPTIONS,
      useFactory: async (factory: QueueModuleOptionsFactory) => factory.createQueueOptions(),
      inject: [factoryType],
    };
    if (options.useClass) {
      return [{ provide: options.useClass, useClass: options.useClass }, optionsProvider];
    }
    return [optionsProvider];
  }
}
