import {
  Module,
  DynamicModule,
  Global,
  Type,
  type Provider,
  type InjectionToken,
  type OptionalFactoryDependency,
} from '@nestjs/common';
import { type DatabaseAdapter } from '@zucker/core';
import { DynamicQueryService, DynamicQueryParamService } from './dynamic-query.service';
import {
  FilterOperatorFactory,
  FILTER_OPERATORS,
  ALL_OPERATORS,
} from './operators';

export const DATABASE_ADAPTER = 'DATABASE_ADAPTER';

export interface CrudModuleAsyncOptions {
  imports?: Array<Type | DynamicModule>;
  useFactory?: (...args: unknown[]) => DatabaseAdapter | Promise<DatabaseAdapter>;
  useClass?: Type<DatabaseAdapter>;
  useExisting?: InjectionToken;
  inject?: Array<InjectionToken | OptionalFactoryDependency>;
}

@Global()
@Module({})
export class ZuckerCrudModule {
  static forRoot(options: { adapterClass: Type<DatabaseAdapter> }): DynamicModule {
    return {
      module: ZuckerCrudModule,
      providers: [
        { provide: DATABASE_ADAPTER, useClass: options.adapterClass },
        ...ALL_OPERATORS,
        {
          provide: FILTER_OPERATORS,
          useFactory: (...operators: InstanceType<(typeof ALL_OPERATORS)[number]>[]) => operators,
          inject: ALL_OPERATORS,
        },
        FilterOperatorFactory,
        DynamicQueryParamService,
        DynamicQueryService,
      ],
      exports: [
        DATABASE_ADAPTER,
        DynamicQueryService,
        DynamicQueryParamService,
        FilterOperatorFactory,
      ],
    };
  }

  static forRootAsync(options: CrudModuleAsyncOptions): DynamicModule {
    const adapterProvider = this.createAdapterProvider(options);
    return {
      module: ZuckerCrudModule,
      imports: options.imports ?? [],
      providers: [
        adapterProvider,
        ...ALL_OPERATORS,
        {
          provide: FILTER_OPERATORS,
          useFactory: (...operators: InstanceType<(typeof ALL_OPERATORS)[number]>[]) => operators,
          inject: ALL_OPERATORS,
        },
        FilterOperatorFactory,
        DynamicQueryParamService,
        DynamicQueryService,
      ],
      exports: [
        DATABASE_ADAPTER,
        DynamicQueryService,
        DynamicQueryParamService,
        FilterOperatorFactory,
      ],
    };
  }

  private static createAdapterProvider(options: CrudModuleAsyncOptions): Provider {
    if (options.useFactory) {
      return {
        provide: DATABASE_ADAPTER,
        useFactory: options.useFactory,
        inject: options.inject ?? [],
      };
    }
    if (options.useClass) {
      return { provide: DATABASE_ADAPTER, useClass: options.useClass };
    }
    return { provide: DATABASE_ADAPTER, useExisting: options.useExisting! };
  }
}
