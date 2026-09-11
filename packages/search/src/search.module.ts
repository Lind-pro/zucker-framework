import {
  Module,
  DynamicModule,
  Global,
  type Provider,
  type Type,
  type InjectionToken,
  type OptionalFactoryDependency,
} from '@nestjs/common';
import { SearchService, SEARCH_CLIENT, type SearchClient, type SearchServiceOptions } from './search.service';

export interface SearchModuleOptions extends SearchServiceOptions {
  client: SearchClient;
}

export interface SearchModuleAsyncOptions {
  imports?: Array<Type | DynamicModule>;
  useFactory?: (...args: unknown[]) => SearchClient | SearchModuleOptions | Promise<SearchClient | SearchModuleOptions>;
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
        { provide: SearchService, useFactory: () => new SearchService(options.client, options) },
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
        {
          provide: SEARCH_CLIENT,
          useFactory: (options: SearchModuleOptions) => options.client,
          inject: [SEARCH_MODULE_OPTIONS],
        },
        {
          provide: SearchService,
          useFactory: (options: SearchModuleOptions) => new SearchService(options.client, options),
          inject: [SEARCH_MODULE_OPTIONS],
        },
      ],
      exports: [SEARCH_CLIENT, SearchService],
    };
  }

  private static createAsyncProviders(options: SearchModuleAsyncOptions): Provider[] {
    if (options.useFactory) {
      return [
        {
          provide: SEARCH_MODULE_OPTIONS,
          useFactory: async (...args: unknown[]) => {
            const result = await options.useFactory!(...args);
            return 'index' in result ? { client: result } : result;
          },
          inject: options.inject ?? [],
        },
      ];
    }

    const clientProvider: Provider = {
      provide: SEARCH_MODULE_OPTIONS,
      useFactory: async (factory: SearchModuleOptionsFactory) => ({ client: await factory.createSearchClient() }),
      inject: [options.useClass ?? options.useExisting!],
    };

    if (options.useClass) {
      return [{ provide: options.useClass, useClass: options.useClass }, clientProvider];
    }
    return [clientProvider];
  }
}
