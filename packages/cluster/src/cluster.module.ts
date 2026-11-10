import { Module, Global, type DynamicModule, type ModuleMetadata } from '@nestjs/common';
import { RedisClusterManager, type ClusterManagerOptions, type RedisLike } from './cluster-manager';
import { RedisDistributedLock } from './distributed-lock';

export interface ZuckerClusterModuleOptions {
  redis: RedisLike;
  /** Cluster membership options. Omit to provide only the distributed lock. */
  cluster?: ClusterManagerOptions;
  /** Key prefix for distributed locks (default: `zucker:lock:`). */
  lockPrefix?: string;
}

export interface ZuckerClusterModuleAsyncOptions extends Pick<ModuleMetadata, 'imports'> {
  inject?: Array<string | symbol | (abstract new (...args: never[]) => unknown) | (new (...args: never[]) => unknown)>;
  useFactory: (...args: never[]) => ZuckerClusterModuleOptions | Promise<ZuckerClusterModuleOptions>;
}

export const ZUCKER_CLUSTER_OPTIONS = Symbol('ZUCKER_CLUSTER_OPTIONS');

function configuredProviders() {
  return [
    {
      provide: RedisClusterManager,
      inject: [ZUCKER_CLUSTER_OPTIONS],
      useFactory: (options: ZuckerClusterModuleOptions) => {
        const manager = new RedisClusterManager();
        // Configured before onModuleInit, so the node joins during startup.
        if (options.cluster) manager.configure(options.cluster, options.redis);
        return manager;
      },
    },
    {
      provide: RedisDistributedLock,
      inject: [ZUCKER_CLUSTER_OPTIONS],
      useFactory: (options: ZuckerClusterModuleOptions) => {
        const lock = new RedisDistributedLock();
        lock.configure(options.redis, options.lockPrefix);
        return lock;
      },
    },
  ];
}

/** Host for `forRoot` / `forRootAsync` so the configured providers do not mix with the legacy static ones. */
@Module({})
export class ZuckerClusterConfiguredModule {}

/**
 * Importing the module class directly keeps the legacy behaviour: unconfigured
 * providers that the application configures itself (`configure()` may be
 * called during or after `onModuleInit`; the cluster manager joins as soon as
 * it is configured). Prefer `forRoot` / `forRootAsync`.
 */
@Global()
@Module({
  providers: [RedisClusterManager, RedisDistributedLock],
  exports: [RedisClusterManager, RedisDistributedLock],
})
export class ZuckerClusterModule {
  static forRoot(options: ZuckerClusterModuleOptions): DynamicModule {
    return {
      module: ZuckerClusterConfiguredModule,
      global: true,
      providers: [{ provide: ZUCKER_CLUSTER_OPTIONS, useValue: options }, ...configuredProviders()],
      exports: [RedisClusterManager, RedisDistributedLock],
    };
  }

  static forRootAsync(options: ZuckerClusterModuleAsyncOptions): DynamicModule {
    return {
      module: ZuckerClusterConfiguredModule,
      global: true,
      imports: options.imports ?? [],
      providers: [
        {
          provide: ZUCKER_CLUSTER_OPTIONS,
          inject: options.inject ?? [],
          useFactory: options.useFactory as (...args: unknown[]) => unknown,
        },
        ...configuredProviders(),
      ],
      exports: [RedisClusterManager, RedisDistributedLock],
    };
  }
}
