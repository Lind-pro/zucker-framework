import {
  Module,
  DynamicModule,
  Global,
  type Provider,
  type Type,
  type InjectionToken,
  type OptionalFactoryDependency,
} from '@nestjs/common';
import { SearchService, SEARCH_CLIENT, type SearchClient } from './search.service';

export interface SearchModuleOptions {
  client: SearchClient;
}

export interface SearchModuleAsyncOptions {
  imports?: Array<Type | DynamicModule>;
  useFactory?: (...args: unknown[]) => SearchClient | Promise<SearchClient>;
  useClass?: Type<SearchModuleOptionsFactory>;
  useExisting?: Type<SearchModuleOptionsFactory>;
  inject?: Array<InjectionToken | OptionalFactoryDependency>;
}

export interface SearchModuleOptionsFactory {
  createSearchClient(): SearchClient | Promise<SearchClient>;
}

const SEARCH_MODULE_OPTIONS = Symbol('SEARCH_MODULE_OPTIONS');

@Global()
@Module({})
export class ZuckerSearchModule {
  static forRoot(options: SearchModuleOptions): DynamicModule {
    return {
      module: ZuckerSearchModule,
      global: true,
      providers: [
        {
          provide: SEARCH_CLIENT,
          useValue: options.client,
        },
        SearchService,
      ],
      exports: [SEARCH_CLIENT, SearchService],
    };
  }

  static forRootAsync(options: SearchModuleAsyncOptions): DynamicModule {
    const asyncProviders = this.createAsyncProviders(options);
    return {
      module: ZuckerSearchModule,
      global: true,
      imports: options.imports ?? [],
      providers: [
        ...asyncProviders,
        SearchService,
      ],
      exports: [SEARCH_CLIENT, SearchService],
    };
  }

  private static createAsyncProviders(options: SearchModuleAsyncOptions): Provider[] {
    if (options.useFactory) {
      return [
        {
          provide: SEARCH_CLIENT,
          useFactory: options.useFactory,
          inject: options.inject ?? [],
        },
      ];
    }

    const clientProvider: Provider = {
      provide: SEARCH_CLIENT,
      useFactory: async (factory: SearchModuleOptionsFactory) => factory.createSearchClient(),
      inject: [options.useClass ?? options.useExisting!],
    };

    if (options.useClass) {
      return [{ provide: options.useClass, useClass: options.useClass }, clientProvider];
    }
    return [clientProvider];
  }
}
