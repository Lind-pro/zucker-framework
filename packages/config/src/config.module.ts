import {
  Module,
  DynamicModule,
  Global,
  type Provider,
  type Type,
  type InjectionToken,
  type OptionalFactoryDependency,
} from '@nestjs/common';
import { ConfigService, CONFIG_ENCRYPTOR } from './config.service';
import { ConfigScopeManager } from './config-scope-manager';
import type { ConfigScopeCustomizer } from './config-scope-manager';
import type { ConfigEncryptor } from './config.service';
import { LayeredConfigService } from './layered-config.service';

export interface ZuckerConfigModuleOptions {
  /** Optional encryption adapter for sensitive config values */
  encryptor?: ConfigEncryptor;
  /** Optional scope customizers to register scopes during init */
  customizers?: ConfigScopeCustomizer[];
}

export const CONFIG_MODULE_OPTIONS = Symbol('CONFIG_MODULE_OPTIONS');

export interface ZuckerConfigModuleAsyncOptions {
  imports?: Array<Type | DynamicModule>;
  useFactory?: (...args: unknown[]) => ZuckerConfigModuleOptions | Promise<ZuckerConfigModuleOptions>;
  useClass?: Type<ZuckerConfigModuleOptionsFactory>;
  useExisting?: Type<ZuckerConfigModuleOptionsFactory>;
  inject?: Array<InjectionToken | OptionalFactoryDependency>;
}

export interface ZuckerConfigModuleOptionsFactory {
  createConfigOptions(): ZuckerConfigModuleOptions | Promise<ZuckerConfigModuleOptions>;
}

@Global()
@Module({})
export class ZuckerConfigModule {
  static forRoot(options?: ZuckerConfigModuleOptions): DynamicModule {
    const providers: Provider[] = [
      ConfigService,
      ConfigScopeManager,
      LayeredConfigService,
    ];

    if (options?.encryptor) {
      providers.push({
        provide: CONFIG_ENCRYPTOR,
        useValue: options.encryptor,
      });
    }

    return {
      module: ZuckerConfigModule,
      global: true,
      providers,
      exports: [ConfigService, ConfigScopeManager, LayeredConfigService],
    };
  }

  static forRootAsync(options: ZuckerConfigModuleAsyncOptions): DynamicModule {
    const asyncProviders = this.createAsyncProviders(options);
    return {
      module: ZuckerConfigModule,
      global: true,
      imports: options.imports ?? [],
      providers: [
        ...asyncProviders,
        {
          provide: CONFIG_ENCRYPTOR,
          useFactory: (opts: ZuckerConfigModuleOptions) => opts.encryptor ?? null,
          inject: [CONFIG_MODULE_OPTIONS],
        },
        ConfigService,
        ConfigScopeManager,
        LayeredConfigService,
      ],
      exports: [ConfigService, ConfigScopeManager, LayeredConfigService],
    };
  }

  private static createAsyncProviders(options: ZuckerConfigModuleAsyncOptions): Provider[] {
    if (options.useFactory) {
      return [
        {
          provide: CONFIG_MODULE_OPTIONS,
          useFactory: options.useFactory,
          inject: options.inject ?? [],
        },
      ];
    }
    const optionsProvider: Provider = {
      provide: CONFIG_MODULE_OPTIONS,
      useFactory: async (factory: ZuckerConfigModuleOptionsFactory) => factory.createConfigOptions(),
      inject: [options.useClass ?? options.useExisting!],
    };
    if (options.useClass) {
      return [{ provide: options.useClass, useClass: options.useClass }, optionsProvider];
    }
    return [optionsProvider];
  }
}
