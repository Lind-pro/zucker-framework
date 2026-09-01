import {
  Module,
  Global,
  type DynamicModule,
  type Provider,
  type Type,
  type InjectionToken,
  type OptionalFactoryDependency,
} from '@nestjs/common';
import { AIProviderManager } from './provider-manager';
import { AIConfigService } from './config.service';
import { AICallWrapper } from './call-wrapper';
import { PromptManager } from './prompt-manager';
import { CostTracker } from './cost-tracker';
import { AICallObserverRegistry } from './call-observer';
import { MediaProviderManager } from './media-provider-manager';
import { MediaGenerationService } from './media-generation.service';
import { AI_CONFIG_SOURCES, type AIConfigSource } from './config-source';

export interface AIModuleOptions {
  /** Default provider key (e.g. 'openai', 'anthropic') */
  defaultProvider?: string;
  /** Default model to use when none specified */
  defaultModel?: string;
  /** Ordered by priority (higher first). Database remains the legacy fallback when available. */
  configSources?: AIConfigSource[];
}

export const AI_MODULE_OPTIONS = Symbol('AI_MODULE_OPTIONS');

export interface AIModuleAsyncOptions {
  imports?: Array<Type | DynamicModule>;
  useFactory?: (...args: unknown[]) => AIModuleOptions | Promise<AIModuleOptions>;
  useClass?: Type<AIModuleOptionsFactory>;
  useExisting?: Type<AIModuleOptionsFactory>;
  inject?: Array<InjectionToken | OptionalFactoryDependency>;
}

export interface AIModuleOptionsFactory {
  createAIModuleOptions(): AIModuleOptions | Promise<AIModuleOptions>;
}

@Global()
@Module({})
export class ZuckerAIModule {
  static forRoot(options?: AIModuleOptions): DynamicModule {
    return {
      module: ZuckerAIModule,
      global: true,
      providers: [
        { provide: AI_MODULE_OPTIONS, useValue: options ?? {} },
        this.createConfigSourcesProvider(),
        AIProviderManager,
        AIConfigService,
        AICallWrapper,
        AICallObserverRegistry,
        PromptManager,
        CostTracker,
        MediaProviderManager,
        MediaGenerationService,
      ],
      exports: [
        AI_MODULE_OPTIONS,
        AI_CONFIG_SOURCES,
        AIProviderManager,
        AIConfigService,
        AICallWrapper,
        AICallObserverRegistry,
        PromptManager,
        CostTracker,
        MediaProviderManager,
        MediaGenerationService,
      ],
    };
  }

  static forRootAsync(options: AIModuleAsyncOptions): DynamicModule {
    const asyncProviders = this.createAsyncProviders(options);
    return {
      module: ZuckerAIModule,
      global: true,
      imports: options.imports ?? [],
      providers: [
        ...asyncProviders,
        this.createConfigSourcesProvider(),
        AIProviderManager,
        AIConfigService,
        AICallWrapper,
        AICallObserverRegistry,
        PromptManager,
        CostTracker,
        MediaProviderManager,
        MediaGenerationService,
      ],
      exports: [
        AI_MODULE_OPTIONS,
        AI_CONFIG_SOURCES,
        AIProviderManager,
        AIConfigService,
        AICallWrapper,
        AICallObserverRegistry,
        PromptManager,
        CostTracker,
        MediaProviderManager,
        MediaGenerationService,
      ],
    };
  }

  private static createAsyncProviders(options: AIModuleAsyncOptions): Provider[] {
    if (options.useFactory) {
      return [
        {
          provide: AI_MODULE_OPTIONS,
          useFactory: options.useFactory,
          inject: options.inject ?? [],
        },
      ];
    }
    const factoryType = options.useClass ?? options.useExisting;
    if (!factoryType) {
      throw new Error('ZuckerAIModule.forRootAsync requires useFactory, useClass, or useExisting');
    }
    const optionsProvider: Provider = {
      provide: AI_MODULE_OPTIONS,
      useFactory: async (factory: AIModuleOptionsFactory) => factory.createAIModuleOptions(),
      inject: [factoryType],
    };
    if (options.useClass) {
      return [{ provide: options.useClass, useClass: options.useClass }, optionsProvider];
    }
    return [optionsProvider];
  }

  private static createConfigSourcesProvider(): Provider {
    return {
      provide: AI_CONFIG_SOURCES,
      useFactory: (options: AIModuleOptions): AIConfigSource[] => options.configSources ?? [],
      inject: [AI_MODULE_OPTIONS],
    };
  }
}
