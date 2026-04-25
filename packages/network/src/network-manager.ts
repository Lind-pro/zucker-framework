import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import type { Network } from './network';
import type { NetworkType } from './network-type';
import type { NetworkProvider } from './network-provider';
import type { NetworkProperties } from './network-config';

/**
 * 网络组件配置管理接口 — 用于从持久层获取 NetworkProperties。
 *
 * 对应 jetlinks `NetworkConfigManager`。
 * 具体实现由应用层提供（数据库、文件等）。
 */
export interface NetworkConfigManager {
  getConfig(type: NetworkType, id: string): Promise<NetworkProperties | undefined>;
}

/**
 * 网络管理器接口。
 *
 * 对应 jetlinks `NetworkManager` — 统一管理多种类型的网络组件实例，
 * 提供按类型+ID 获取、重载、关闭、销毁等操作。
 */
export interface INetworkManager {
  /** 按类型和 ID 获取网络组件（懒创建） */
  getNetwork<T extends Network = Network>(type: NetworkType, id: string): Promise<T>;

  /** 获取所有已创建的网络组件 */
  getNetworks(): Network[];

  /** 获取所有已注册的 Provider */
  getProviders(): NetworkProvider[];

  /** 按类型 ID 获取 Provider */
  getProvider(typeId: string): NetworkProvider | undefined;

  /** 重载指定网络组件 */
  reload(type: NetworkType, id: string): Promise<void>;

  /** 关闭指定网络组件（不移除缓存） */
  shutdown(type: NetworkType, id: string): Promise<void>;

  /** 销毁指定网络组件（关闭并移除缓存） */
  destroy(type: NetworkType, id: string): Promise<void>;
}

/**
 * 默认网络管理器实现。
 *
 * 对应 jetlinks `DefaultNetworkManager` — 通过 Provider SPI 按需创建
 * 网络组件实例，内部按 type + id 缓存。
 *
 * 与 jetlinks 的差异：
 * - 去掉了 Spring BeanPostProcessor 自动发现，改为手动 registerProvider
 * - 去掉了 EventBus 集群同步（zucker 已有 @zucker/cluster）
 * - 健康检查用 setInterval 而非 Flux.interval
 */
@Injectable()
export class DefaultNetworkManager implements INetworkManager, OnModuleDestroy {
  private readonly logger = new Logger(DefaultNetworkManager.name);

  /** type-id -> Provider */
  private readonly providers = new Map<string, NetworkProvider<unknown>>();

  /** type-id -> (network-id -> Network) */
  private readonly store = new Map<string, Map<string, Network>>();

  private checkTimer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly configManager: NetworkConfigManager) {
    // 每 10 秒检查网络组件存活状态，与 jetlinks 的 10s 周期一致
    this.checkTimer = setInterval(() => {
      this.checkNetworks().catch((err) =>
        this.logger.error('Network health-check failed', err),
      );
    }, 10_000);
  }

  /* ------------------------------------------------------------------ */
  /*  Provider 注册                                                      */
  /* ------------------------------------------------------------------ */

  registerProvider(provider: NetworkProvider<unknown>): void {
    this.providers.set(provider.type.id, provider);
    this.logger.log(`NetworkProvider registered: ${provider.type.id}`);
  }

  /* ------------------------------------------------------------------ */
  /*  INetworkManager 实现                                               */
  /* ------------------------------------------------------------------ */

  async getNetwork<T extends Network = Network>(type: NetworkType, id: string): Promise<T> {
    const networkMap = this.getNetworkStore(type.id);
    let network = networkMap.get(id) as T | undefined;
    if (network) return network;

    network = (await this.createFromConfig(type, id)) as T;
    networkMap.set(id, network);
    return network;
  }

  getNetworks(): Network[] {
    const result: Network[] = [];
    for (const map of this.store.values()) {
      for (const n of map.values()) {
        result.push(n);
      }
    }
    return result;
  }

  getProviders(): NetworkProvider[] {
    return Array.from(this.providers.values());
  }

  getProvider(typeId: string): NetworkProvider | undefined {
    return this.providers.get(typeId);
  }

  async reload(type: NetworkType, id: string): Promise<void> {
    const provider = this.requireProvider(type.id);
    const props = await this.configManager.getConfig(type, id);
    if (!props || !props.enabled) return;

    const config = await provider.createConfig(props);
    const networkMap = this.getNetworkStore(type.id);
    const existing = networkMap.get(id);

    const network = existing
      ? await provider.reload(existing, config)
      : await provider.createNetwork(config);
    networkMap.set(id, network);
  }

  async shutdown(type: NetworkType, id: string): Promise<void> {
    const network = this.getNetworkStore(type.id).get(id);
    if (network) {
      await network.shutdown();
    }
  }

  async destroy(type: NetworkType, id: string): Promise<void> {
    const networkMap = this.getNetworkStore(type.id);
    const network = networkMap.get(id);
    if (network) {
      networkMap.delete(id);
      await network.shutdown();
    }
  }

  /* ------------------------------------------------------------------ */
  /*  生命周期                                                           */
  /* ------------------------------------------------------------------ */

  async onModuleDestroy(): Promise<void> {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = undefined;
    }
    // 关闭所有网络组件
    const shutdowns: Promise<void>[] = [];
    for (const map of this.store.values()) {
      for (const network of map.values()) {
        shutdowns.push(
          Promise.resolve(network.shutdown()).catch((err) =>
            this.logger.error(`Failed to shutdown network ${network.id}`, err),
          ),
        );
      }
    }
    await Promise.all(shutdowns);
    this.store.clear();
  }

  /* ------------------------------------------------------------------ */
  /*  内部方法                                                           */
  /* ------------------------------------------------------------------ */

  private getNetworkStore(typeId: string): Map<string, Network> {
    let map = this.store.get(typeId);
    if (!map) {
      map = new Map();
      this.store.set(typeId, map);
    }
    return map;
  }

  private requireProvider(typeId: string): NetworkProvider<unknown> {
    const provider = this.providers.get(typeId);
    if (!provider) {
      throw new Error(`Unsupported network type: ${typeId}`);
    }
    return provider;
  }

  private async createFromConfig(type: NetworkType, id: string): Promise<Network> {
    const provider = this.requireProvider(type.id);
    const props = await this.configManager.getConfig(type, id);
    if (!props || !props.enabled) {
      throw new Error(`Network config not found or disabled: ${type.id}/${id}`);
    }
    const config = await provider.createConfig(props);
    return provider.createNetwork(config);
  }

  /**
   * 定期检查网络组件存活状态 — 与 jetlinks checkNetwork() 逻辑对齐。
   */
  private async checkNetworks(): Promise<void> {
    for (const [typeId, networkMap] of this.store) {
      const provider = this.providers.get(typeId);
      if (!provider) continue;

      for (const [id, network] of networkMap) {
        if (network.isAlive() || !network.isAutoReload()) continue;

        try {
          const props = await this.configManager.getConfig(network.type, id);
          if (!props || !props.enabled) continue;

          const config = await provider.createConfig(props);
          const reloaded = await provider.reload(network, config);
          networkMap.set(id, reloaded);
          this.logger.log(`Reloaded network: ${typeId}/${id}`);
        } catch (err) {
          this.logger.warn(`Failed to reload network ${typeId}/${id}`, err);
        }
      }
    }
  }
}
