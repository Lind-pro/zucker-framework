import { Inject, Module, RequestMethod, type MiddlewareConsumer, type NestModule, type OnModuleDestroy } from '@nestjs/common';
import {
  AIConfigService,
  AICallWrapper,
  NativeAIClient,
  type NativeModelFactory,
} from '@zucker-framework/ai';
import { createNativeAIModel } from '@zucker-framework/ai/native';
import { liveArrayView, liveObjectView } from '@zucker-framework/back-office/settings';
import { AI_CONNECTION_RUNTIME, AIConnectionRuntimeModule, bindAIConfigCacheToRuntime, type AIConnectionRuntime } from './ai-connection-runtime';
import { AI_MEDIA_PROVIDERS } from './ai-media-providers';
import { aiTestFakeChatFactory, aiTestFakesEnabled } from './ai-test-fakes';

/** Explicit test/transport seam; production defaults to the existing native SDK factory. */
export const AI_NATIVE_MODEL_FACTORY = Symbol('AI_NATIVE_MODEL_FACTORY');
/**
 * Environment read by AI features (connection enablement, models, media adapters): a live read-only
 * view of the current `ai-*` profile revision (pinned per request under `/ai`, `/v1/ai` and `/chat`).
 */
export const AI_CONNECTION_ENVIRONMENT = Symbol('AI_CONNECTION_ENVIRONMENT');
/** Requests that use AI connections; each is pinned to one revision of the AI profiles. */
const AI_ROUTES = ['ai{/*splat}', 'v1/ai{/*splat}', 'chat{/*splat}'];
@Module({
  imports: [AIConnectionRuntimeModule],
  providers: [
    {
      provide: AI_NATIVE_MODEL_FACTORY,
      inject: [AI_CONNECTION_ENVIRONMENT],
      // AI_TEST_FAKE_PROVIDERS=true (refused in production) swaps in the deterministic fakes for e2e runs.
      useFactory: async (env: Readonly<NodeJS.ProcessEnv>): Promise<NativeModelFactory> =>
        aiTestFakesEnabled(env) ? aiTestFakeChatFactory(env) : createNativeAIModel,
    },
    {
      provide: NativeAIClient,
      inject: [AIConfigService, AICallWrapper, AI_NATIVE_MODEL_FACTORY, AI_CONNECTION_RUNTIME],
      useFactory: (configs: AIConfigService, calls: AICallWrapper, factory: NativeModelFactory, runtime: AIConnectionRuntime) => {
        // The terminal runtime source is hot: AIConfigService's per-scenario cache would otherwise serve
        // a superseded key or model, so it is invalidated whenever the AI profile revision changes.
        bindAIConfigCacheToRuntime(configs, runtime);
        return new NativeAIClient(configs, calls, factory);
      },
    },
    {
      provide: AI_CONNECTION_ENVIRONMENT,
      inject: [AI_CONNECTION_RUNTIME],
      useFactory: (runtime: AIConnectionRuntime) => liveObjectView(() => runtime.now().environment),
    },
    {
      provide: AI_MEDIA_PROVIDERS,
      inject: [AI_CONNECTION_RUNTIME],
      useFactory: (runtime: AIConnectionRuntime) => liveArrayView(() => runtime.now().media),
    },
  ],
  exports: [NativeAIClient, AI_CONNECTION_ENVIRONMENT, AI_MEDIA_PROVIDERS, AIConnectionRuntimeModule],
})
export class AIConnectionsModule implements NestModule, OnModuleDestroy {
  constructor(@Inject(AI_CONNECTION_RUNTIME) private readonly runtime: AIConnectionRuntime) {}
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(this.runtime.middleware()).forRoutes(...AI_ROUTES.map(path => ({ path, method: RequestMethod.ALL })));
  }
  async onModuleDestroy(): Promise<void> { await this.runtime.close(); }
}
