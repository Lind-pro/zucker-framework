import { Module } from '@nestjs/common';
import {
  AIConfigService,
  AICallWrapper,
  NativeAIClient,
  type NativeModelFactory,
} from '@zucker-framework/ai';
import { createNativeAIModel } from '@zucker-framework/ai/native';

/** Explicit test/transport seam; production defaults to the existing native SDK factory. */
export const AI_NATIVE_MODEL_FACTORY = Symbol('AI_NATIVE_MODEL_FACTORY');
@Module({
  providers: [
    { provide: AI_NATIVE_MODEL_FACTORY, useValue: createNativeAIModel },
    {
      provide: NativeAIClient,
      inject: [AIConfigService, AICallWrapper, AI_NATIVE_MODEL_FACTORY],
      useFactory: (configs: AIConfigService, calls: AICallWrapper, factory: NativeModelFactory) =>
        new NativeAIClient(configs, calls, factory),
    },
  ],
  exports: [NativeAIClient],
})
export class AIConnectionsModule {}
