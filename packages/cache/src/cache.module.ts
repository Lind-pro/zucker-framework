import {
  Module,
  DynamicModule,
  Global,
  type Provider,
  type Type,
  type InjectionToken,
  type OptionalFactoryDependency,
} from '@nestjs/common';
import { MemoryCache } from './memory-cache';
import { RedisCache, type RedisClient } from './redis-cache';
import { HybridCache } from './hybrid-cache';
import type { ICache } from './cache.interface';

export const CACHE_PROVIDER = 'CACHE_PROVIDER';

export interface CacheModuleOptions {
  provider: 'memory' | 'redis' | 'hybrid';
  redis?: {
    client: RedisClient;
    prefix?: string;
  };
  defaultTtlMs?: number;
}

export interface CacheModuleAsyncOptions {
  imports?: Array<Type | DynamicModule>;
  useFactory?: (...args: unknown[]) => CacheModuleOptions | Promise<CacheModuleOptions>;
  useClass?: Type<CacheModuleOptionsFactory>;
  useExisting?: Type<CacheModuleOptionsFactory>;
  inject?: Array<InjectionToken | OptionalFactoryDependency>;
}

export interface CacheModuleOptionsFactory {
  createCacheOptions(): CacheModuleOptions | Promise<CacheModuleOptions>;
}

const CACHE_MODULE_OPTIONS = Symbol('CACHE_MODULE_OPTIONS');

@Global()
@Module({})
export class ZuckerCacheModule {
  static forRoot(options: CacheModuleOptions): DynamicModule {
    return {
      module: ZuckerCacheModule,
      providers: [
        {
          provide: CACHE_PROVIDER,
          useFactory: (): ICache => ZuckerCacheModule.createCache(options),
        },
      ],
      exports: [CACHE_PROVIDER],
    };
  }

  static forRootAsync(options: CacheModuleAsyncOptions): DynamicModule {
    const asyncProviders = this.createAsyncProviders(options);
    return {
      module: ZuckerCacheModule,
      imports: options.imports ?? [],
      providers: [
        ...asyncProviders,
        {
          provide: CACHE_PROVIDER,
          useFactory: (opts: CacheModuleOptions): ICache => ZuckerCacheModule.createCache(opts),
          inject: [CACHE_MODULE_OPTIONS],
        },
      ],
      exports: [CACHE_PROVIDER],
    };
  }

  private static createCache(options: CacheModuleOptions): ICache {
    const memory = new MemoryCache({ defaultTtlMs: options.defaultTtlMs });

    if (options.provider === 'memory') {
      return memory;
    }

    if (options.provider === 'redis') {
      return new RedisCache(options.redis!.client, {
        prefix: options.redis?.prefix,
      });
    }

    // hybrid
    const redis = new RedisCache(options.redis!.client, {
      prefix: options.redis?.prefix,
    });
    return new HybridCache(memory, redis);
  }

  private static createAsyncProviders(options: CacheModuleAsyncOptions): Provider[] {
    if (options.useFactory) {
      return [
        {
          provide: CACHE_MODULE_OPTIONS,
          useFactory: options.useFactory,
          inject: options.inject ?? [],
        },
      ];
    }
    const optionsProvider: Provider = {
      provide: CACHE_MODULE_OPTIONS,
      useFactory: async (factory: CacheModuleOptionsFactory) => factory.createCacheOptions(),
      inject: [options.useClass ?? options.useExisting!],
    };
    if (options.useClass) {
      return [{ provide: options.useClass, useClass: options.useClass }, optionsProvider];
    }
    return [optionsProvider];
  }
}
