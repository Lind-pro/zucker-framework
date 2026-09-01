import { Module, Global } from '@nestjs/common';
import { DefaultProviderRegistry } from './provider-registry';
import { DefaultStrategyManager } from './strategy-manager';

export const PROVIDER_REGISTRY = Symbol('PROVIDER_REGISTRY');
export const STRATEGY_MANAGER = Symbol('STRATEGY_MANAGER');

@Global()
@Module({
  providers: [
    {
      provide: PROVIDER_REGISTRY,
      useClass: DefaultProviderRegistry,
    },
    {
      provide: STRATEGY_MANAGER,
      useClass: DefaultStrategyManager,
    },
  ],
  exports: [PROVIDER_REGISTRY, STRATEGY_MANAGER],
})
export class ZuckerProviderModule {}
