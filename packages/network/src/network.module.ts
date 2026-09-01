import { Module, type DynamicModule, type Provider as NestProvider } from '@nestjs/common';
import { DefaultNetworkManager, type NetworkConfigManager } from './network-manager';

export const NETWORK_MANAGER = Symbol('NETWORK_MANAGER');
export const NETWORK_CONFIG_MANAGER = Symbol('NETWORK_CONFIG_MANAGER');

/**
 * Zucker 网络模块。
 *
 * 使用 `forRoot` 注册时，需提供 `NetworkConfigManager` 实现。
 *
 * ```ts
 * ZuckerNetworkModule.forRoot({
 *   configManager: MyNetworkConfigManager,
 * })
 * ```
 */
@Module({})
export class ZuckerNetworkModule {
  static forRoot(options: {
    configManager: NestProvider;
  }): DynamicModule {
    const configManagerProvider: NestProvider =
      typeof options.configManager === 'function'
        ? { provide: NETWORK_CONFIG_MANAGER, useClass: options.configManager as new (...args: unknown[]) => NetworkConfigManager }
        : options.configManager;

    const networkManagerProvider: NestProvider = {
      provide: NETWORK_MANAGER,
      useFactory: (configManager: NetworkConfigManager) => {
        return new DefaultNetworkManager(configManager);
      },
      inject: [NETWORK_CONFIG_MANAGER],
    };

    return {
      module: ZuckerNetworkModule,
      global: true,
      providers: [configManagerProvider, networkManagerProvider],
      exports: [NETWORK_MANAGER, NETWORK_CONFIG_MANAGER],
    };
  }
}
