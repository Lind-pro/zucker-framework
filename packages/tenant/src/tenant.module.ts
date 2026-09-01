import {
  Module,
  DynamicModule,
  Global,
  type Provider,
  type Type,
  type InjectionToken,
  type OptionalFactoryDependency,
} from '@nestjs/common';
import { APP_INTERCEPTOR, APP_GUARD } from '@nestjs/core';
import { TenantInterceptor, TenantInterceptorOptions } from './tenant.interceptor';
import { TenantGuard } from './tenant.guard';
import { TenantIsolationStrategy, RowLevelIsolation } from './tenant-isolation';

export const TENANT_ISOLATION_STRATEGY = Symbol('TENANT_ISOLATION_STRATEGY');

export interface TenantModuleOptions extends TenantInterceptorOptions {
  /** 隔离策略，默认行级隔离 */
  isolation?: TenantIsolationStrategy;
  /** 是否全局启用 TenantGuard（默认 false） */
  enableGuard?: boolean;
}

export interface TenantModuleAsyncOptions {
  imports?: Array<Type | DynamicModule>;
  useFactory?: (...args: unknown[]) => TenantModuleOptions | Promise<TenantModuleOptions>;
  useClass?: Type<TenantModuleOptionsFactory>;
  useExisting?: Type<TenantModuleOptionsFactory>;
  inject?: Array<InjectionToken | OptionalFactoryDependency>;
}

export interface TenantModuleOptionsFactory {
  createTenantOptions(): TenantModuleOptions | Promise<TenantModuleOptions>;
}

const TENANT_MODULE_OPTIONS = Symbol('TENANT_MODULE_OPTIONS');

@Global()
@Module({})
export class ZuckerTenantModule {
  static forRoot(options?: TenantModuleOptions): DynamicModule {
    const isolation = options?.isolation ?? new RowLevelIsolation();

    const providers: Provider[] = [
      {
        provide: APP_INTERCEPTOR,
        useFactory: () => new TenantInterceptor(options),
      },
      {
        provide: TENANT_ISOLATION_STRATEGY,
        useValue: isolation,
      },
      TenantGuard,
    ];

    if (options?.enableGuard) {
      providers.push({
        provide: APP_GUARD,
        useExisting: TenantGuard,
      });
    }

    return {
      module: ZuckerTenantModule,
      global: true,
      providers,
      exports: [TENANT_ISOLATION_STRATEGY, TenantGuard],
    };
  }

  static forRootAsync(options: TenantModuleAsyncOptions): DynamicModule {
    const asyncProviders = this.createAsyncProviders(options);
    return {
      module: ZuckerTenantModule,
      global: true,
      imports: options.imports ?? [],
      providers: [
        ...asyncProviders,
        {
          provide: APP_INTERCEPTOR,
          useFactory: (opts: TenantModuleOptions) => new TenantInterceptor(opts),
          inject: [TENANT_MODULE_OPTIONS],
        },
        {
          provide: TENANT_ISOLATION_STRATEGY,
          useFactory: (opts: TenantModuleOptions) =>
            opts.isolation ?? new RowLevelIsolation(),
          inject: [TENANT_MODULE_OPTIONS],
        },
        TenantGuard,
      ],
      exports: [TENANT_ISOLATION_STRATEGY, TenantGuard],
    };
  }

  private static createAsyncProviders(options: TenantModuleAsyncOptions): Provider[] {
    if (options.useFactory) {
      return [
        {
          provide: TENANT_MODULE_OPTIONS,
          useFactory: options.useFactory,
          inject: options.inject ?? [],
        },
      ];
    }
    const optionsProvider: Provider = {
      provide: TENANT_MODULE_OPTIONS,
      useFactory: async (factory: TenantModuleOptionsFactory) => factory.createTenantOptions(),
      inject: [options.useClass ?? options.useExisting!],
    };
    if (options.useClass) {
      return [{ provide: options.useClass, useClass: options.useClass }, optionsProvider];
    }
    return [optionsProvider];
  }
}
