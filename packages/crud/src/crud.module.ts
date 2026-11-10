import {
  Module,
  DynamicModule,
  Global,
  Type,
  type Provider,
  type InjectionToken,
  type OptionalFactoryDependency,
} from '@nestjs/common';
import { DATABASE_ADAPTER, type DatabaseAdapter } from '@zucker-framework/core';
import { DynamicQueryService, DynamicQueryParamService } from './dynamic-query.service';
import { FilterOperatorFactory, FILTER_OPERATORS, ALL_OPERATORS } from './operators';
import { CRUD_QUERY_POLICY, type CrudQueryPolicy } from './query/query-policy';

export { DATABASE_ADAPTER } from '@zucker-framework/core';

export interface CrudModuleAsyncOptions {
  imports?: Array<Type | DynamicModule>;
  useFactory?: (...args: unknown[]) => DatabaseAdapter | Promise<DatabaseAdapter>;
  useClass?: Type<DatabaseAdapter>;
  useExisting?: InjectionToken;
  inject?: Array<InjectionToken | OptionalFactoryDependency>;
  /** Module-wide default policy for caller-supplied dynamic queries. */
  queryPolicy?: CrudQueryPolicy;
}

@Global()
@Module({})
export class ZuckerCrudModule {
  static forRoot(options: { adapterClass: Type<DatabaseAdapter>; queryPolicy?: CrudQueryPolicy }): DynamicModule {
    return {
      module: ZuckerCrudModule,
      global: true,
      providers: [
        { provide: DATABASE_ADAPTER, useClass: options.adapterClass },
        { provide: CRUD_QUERY_POLICY, useValue: options.queryPolicy ?? {} },
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
        CRUD_QUERY_POLICY,
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
      global: true,
      imports: options.imports ?? [],
      providers: [
        adapterProvider,
        { provide: CRUD_QUERY_POLICY, useValue: options.queryPolicy ?? {} },
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
        CRUD_QUERY_POLICY,
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
