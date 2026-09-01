import {
  Module,
  Global,
  type DynamicModule,
  type Provider,
  type Type,
  type InjectionToken,
  type OptionalFactoryDependency,
} from '@nestjs/common';
import {
  FileMessageSource,
  CompositeMessageSource,
  type MessageSource,
} from './message-source';
import { LocaleInterceptor } from './locale-context';

export const MESSAGE_SOURCE = 'MESSAGE_SOURCE';

export interface I18nModuleOptions {
  /** Path to message files directory */
  basePath?: string;
  /** Default locale */
  defaultLocale?: string;
  /** Supported locales */
  supportedLocales?: string[];
  /** Additional message sources */
  messageSources?: MessageSource[];
}

export interface I18nModuleAsyncOptions {
  imports?: Array<Type | DynamicModule>;
  useFactory?: (...args: unknown[]) => I18nModuleOptions | Promise<I18nModuleOptions>;
  useClass?: Type<I18nModuleOptionsFactory>;
  useExisting?: Type<I18nModuleOptionsFactory>;
  inject?: Array<InjectionToken | OptionalFactoryDependency>;
}

export interface I18nModuleOptionsFactory {
  createI18nOptions(): I18nModuleOptions | Promise<I18nModuleOptions>;
}

const I18N_MODULE_OPTIONS = Symbol('I18N_MODULE_OPTIONS');

@Global()
@Module({})
export class ZuckerI18nModule {
  static forRoot(options: I18nModuleOptions = {}): DynamicModule {
    return {
      module: ZuckerI18nModule,
      global: true,
      providers: ZuckerI18nModule.buildProviders(options),
      exports: [MESSAGE_SOURCE, LocaleInterceptor],
    };
  }

  static forRootAsync(options: I18nModuleAsyncOptions): DynamicModule {
    const asyncProviders = this.createAsyncProviders(options);
    return {
      module: ZuckerI18nModule,
      global: true,
      imports: options.imports ?? [],
      providers: [
        ...asyncProviders,
        {
          provide: MESSAGE_SOURCE,
          useFactory: (opts: I18nModuleOptions) => {
            const sources: MessageSource[] = [];
            if (opts.basePath) {
              sources.push(
                new FileMessageSource(opts.basePath, {
                  defaultLocale: opts.defaultLocale,
                }),
              );
            }
            if (opts.messageSources) {
              sources.push(...opts.messageSources);
            }
            return sources.length === 1
              ? sources[0]
              : new CompositeMessageSource(sources);
          },
          inject: [I18N_MODULE_OPTIONS],
        },
        {
          provide: LocaleInterceptor,
          useFactory: (opts: I18nModuleOptions) =>
            new LocaleInterceptor({
              supportedLocales: opts.supportedLocales,
              defaultLocale: opts.defaultLocale,
            }),
          inject: [I18N_MODULE_OPTIONS],
        },
      ],
      exports: [MESSAGE_SOURCE, LocaleInterceptor],
    };
  }

  private static buildProviders(options: I18nModuleOptions): Provider[] {
    const providers: Provider[] = [];

    // Message source
    const sources: MessageSource[] = [];
    if (options.basePath) {
      sources.push(
        new FileMessageSource(options.basePath, {
          defaultLocale: options.defaultLocale,
        }),
      );
    }
    if (options.messageSources) {
      sources.push(...options.messageSources);
    }

    const messageSource =
      sources.length === 1
        ? sources[0]
        : new CompositeMessageSource(sources);

    providers.push({
      provide: MESSAGE_SOURCE,
      useValue: messageSource,
    });

    // Locale interceptor
    providers.push({
      provide: LocaleInterceptor,
      useValue: new LocaleInterceptor({
        supportedLocales: options.supportedLocales,
        defaultLocale: options.defaultLocale,
      }),
    });

    return providers;
  }

  private static createAsyncProviders(options: I18nModuleAsyncOptions): Provider[] {
    if (options.useFactory) {
      return [
        {
          provide: I18N_MODULE_OPTIONS,
          useFactory: options.useFactory,
          inject: options.inject ?? [],
        },
      ];
    }
    const optionsProvider: Provider = {
      provide: I18N_MODULE_OPTIONS,
      useFactory: async (factory: I18nModuleOptionsFactory) => factory.createI18nOptions(),
      inject: [options.useClass ?? options.useExisting!],
    };
    if (options.useClass) {
      return [{ provide: options.useClass, useClass: options.useClass }, optionsProvider];
    }
    return [optionsProvider];
  }
}
