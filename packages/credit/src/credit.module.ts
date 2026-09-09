import {
  Global,
  Module,
  type DynamicModule,
  type InjectionToken,
  type OptionalFactoryDependency,
  type Provider,
  type Type,
} from '@nestjs/common';
import { CreditService } from './credit.service';
import type { DatabaseAdapter } from '@zucker-framework/core';

export interface CreditModuleAsyncOptions {
  imports?: Array<Type | DynamicModule>;
  useFactory?: (...args: unknown[]) => DatabaseAdapter | Promise<DatabaseAdapter>;
  useClass?: Type<CreditModuleAdapterFactory>;
  useExisting?: Type<CreditModuleAdapterFactory>;
  inject?: Array<InjectionToken | OptionalFactoryDependency>;
}

export interface CreditModuleAdapterFactory {
  createDatabaseAdapter(): DatabaseAdapter | Promise<DatabaseAdapter>;
}

@Global()
@Module({})
export class ZuckerCreditModule {
  static forRoot(): DynamicModule {
    return {
      module: ZuckerCreditModule,
      global: true,
      providers: [CreditService],
      exports: [CreditService],
    };
  }

  static forRootAsync(options: CreditModuleAsyncOptions): DynamicModule {
    const asyncProviders = this.createAsyncProviders(options);
    return {
      module: ZuckerCreditModule,
      global: true,
      imports: options.imports ?? [],
      providers: [...asyncProviders, CreditService],
      exports: [CreditService],
    };
  }

  private static createAsyncProviders(options: CreditModuleAsyncOptions): Provider[] {
    if (options.useFactory) {
      return [
        {
          provide: 'DATABASE_ADAPTER',
          useFactory: options.useFactory,
          inject: options.inject ?? [],
        },
      ];
    }
    const factoryType = options.useClass ?? options.useExisting;
    if (!factoryType) {
      throw new TypeError('CreditModuleAsyncOptions requires useFactory, useClass or useExisting');
    }
    const adapterProvider: Provider = {
      provide: 'DATABASE_ADAPTER',
      useFactory: async (factory: CreditModuleAdapterFactory) => factory.createDatabaseAdapter(),
      inject: [factoryType],
    };
    if (options.useClass) {
      return [{ provide: options.useClass, useClass: options.useClass }, adapterProvider];
    }
    return [adapterProvider];
  }
}
