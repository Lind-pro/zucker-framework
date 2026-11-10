import {
  Module,
  DynamicModule,
  Global,
  type Provider,
  type Type,
  type InjectionToken,
  type OptionalFactoryDependency,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { RateLimiterService, type RateLimiterModuleOptions } from './rate-limiter.service';
import { GlobalRateLimitGuard, RateLimitGuard } from './guards/rate-limit.guard';

export interface RateLimiterModuleAsyncOptions {
  imports?: Array<Type | DynamicModule>;
  /** Register the rate-limit guard globally (routes listing `RateLimitGuard` keep their own copy). Defaults to true. */
  globalGuard?: boolean;
  useFactory?: (...args: unknown[]) => RateLimiterModuleOptions | Promise<RateLimiterModuleOptions>;
  useClass?: Type<RateLimiterModuleOptionsFactory>;
  useExisting?: Type<RateLimiterModuleOptionsFactory>;
  inject?: Array<InjectionToken | OptionalFactoryDependency>;
}

export interface RateLimiterModuleOptionsFactory {
  createRateLimiterOptions(): RateLimiterModuleOptions | Promise<RateLimiterModuleOptions>;
}

const RATE_LIMITER_MODULE_OPTIONS = Symbol('RATE_LIMITER_MODULE_OPTIONS');

@Global()
@Module({})
export class ZuckerRateLimiterModule {
  static forRoot(options: RateLimiterModuleOptions): DynamicModule {
    const providers: Provider[] = [
      {
        provide: RateLimiterService,
        useFactory: () => new RateLimiterService(options),
      },
      { provide: 'RATE_LIMITER_SERVICE', useExisting: RateLimiterService },
      RateLimitGuard,
    ];
    if (options.globalGuard !== false) {
      // Defers to routes that list RateLimitGuard themselves, so a request is never charged twice.
      providers.push(GlobalRateLimitGuard, { provide: APP_GUARD, useExisting: GlobalRateLimitGuard });
    }
    return {
      module: ZuckerRateLimiterModule,
      global: true,
      providers,
      exports: [RateLimiterService, RateLimitGuard, 'RATE_LIMITER_SERVICE'],
    };
  }

  static forRootAsync(options: RateLimiterModuleAsyncOptions): DynamicModule {
    const asyncProviders = this.createAsyncProviders(options);
    const providers: Provider[] = [
      ...asyncProviders,
      {
        provide: RateLimiterService,
        useFactory: (opts: RateLimiterModuleOptions) => new RateLimiterService(opts),
        inject: [RATE_LIMITER_MODULE_OPTIONS],
      },
      { provide: 'RATE_LIMITER_SERVICE', useExisting: RateLimiterService },
      RateLimitGuard,
    ];
    if (options.globalGuard !== false) {
      // Defers to routes that list RateLimitGuard themselves, so a request is never charged twice.
      providers.push(GlobalRateLimitGuard, { provide: APP_GUARD, useExisting: GlobalRateLimitGuard });
    }
    return {
      module: ZuckerRateLimiterModule,
      global: true,
      imports: options.imports ?? [],
      providers,
      exports: [RateLimiterService, RateLimitGuard, 'RATE_LIMITER_SERVICE'],
    };
  }

  private static createAsyncProviders(options: RateLimiterModuleAsyncOptions): Provider[] {
    if (options.useFactory) {
      return [
        {
          provide: RATE_LIMITER_MODULE_OPTIONS,
          useFactory: options.useFactory,
          inject: options.inject ?? [],
        },
      ];
    }
    const optionsProvider: Provider = {
      provide: RATE_LIMITER_MODULE_OPTIONS,
      useFactory: async (factory: RateLimiterModuleOptionsFactory) =>
        factory.createRateLimiterOptions(),
      inject: [options.useClass ?? options.useExisting!],
    };
    if (options.useClass) {
      return [{ provide: options.useClass, useClass: options.useClass }, optionsProvider];
    }
    return [optionsProvider];
  }
}
