import { Module } from '@nestjs/common';
import {
  AIConfigService,
  AICallWrapper,
  NativeAIClient,
  type NativeModelFactory,
} from '@zucker-framework/ai';
import { createNativeAIModel } from '@zucker-framework/ai/native';
import { RUNTIME_ENVIRONMENT } from '../runtime-settings/runtime-settings.tokens';
import { AI_MEDIA_PROVIDERS, aiMediaProvidersFromEnvironment } from './ai-media-providers';
import { aiTestFakeChatFactory, aiTestFakeMediaProviders, aiTestFakesEnabled } from './ai-test-fakes';

/** Explicit test/transport seam; production defaults to the existing native SDK factory. */
export const AI_NATIVE_MODEL_FACTORY = Symbol('AI_NATIVE_MODEL_FACTORY');
/** Startup environment snapshot used by AI features (connection enablement, media adapters). */
export const AI_CONNECTION_ENVIRONMENT = Symbol('AI_CONNECTION_ENVIRONMENT');
@Module({
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
      inject: [AIConfigService, AICallWrapper, AI_NATIVE_MODEL_FACTORY],
      useFactory: (configs: AIConfigService, calls: AICallWrapper, factory: NativeModelFactory) =>
        new NativeAIClient(configs, calls, factory),
    },
    {
      provide: AI_CONNECTION_ENVIRONMENT,
      inject: [{ token: RUNTIME_ENVIRONMENT, optional: true }],
      useFactory: (env?: Readonly<NodeJS.ProcessEnv>) => Object.freeze({ ...(env ?? process.env) }),
    },
    {
      provide: AI_MEDIA_PROVIDERS,
      inject: [AI_CONNECTION_ENVIRONMENT],
      useFactory: async (env: Readonly<NodeJS.ProcessEnv>) =>
        aiTestFakesEnabled(env) ? aiTestFakeMediaProviders(env) : aiMediaProvidersFromEnvironment(env),
    },
  ],
  exports: [NativeAIClient, AI_CONNECTION_ENVIRONMENT, AI_MEDIA_PROVIDERS],
})
export class AIConnectionsModule {}
