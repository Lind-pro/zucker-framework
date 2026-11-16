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
 * - 去掉了 EventBus 集群同步（zucker 已有 @zucker-framework/cluster）
 * - 健康检查用 setInterval 而非 Flux.interval
 */
@Injectable()
export class DefaultNetworkManager implements INetworkManager, OnModuleDestroy {
  private readonly logger = new Logger(DefaultNetworkManager.name);

  /** type-id -> Provider */
  private readonly providers = new Map<string, NetworkProvider<unknown>>();

  /** type-id -> (network-id -> Network) */
  private readonly store = new Map<string, Map<string, Network>>();

  /** type-id/network-id -> 正在进行的创建，保证并发 getNetwork 只创建一次 */
  private readonly pending = new Map<string, Promise<Network>>();

  /** 被显式 shutdown 的网络：保留在缓存中，但健康检查不再自动重载 */
  private readonly stopped = new Set<string>();

  // Serialize lifecycle operations per key. Closing invalidates work already waiting on I/O.
  private readonly operations = new Map<string, Promise<unknown>>();
  private readonly generations = new Map<string, symbol>();
  private closed = false;
  private closing?: Promise<void>;

  private checkTimer: ReturnType<typeof setInterval> | undefined;

  /** 健康检查是否正在运行；慢速重载时跳过下一个 tick，避免重叠 */
  private checking = false;

  constructor(private readonly configManager: NetworkConfigManager) {
    // 每 10 秒检查网络组件存活状态，与 jetlinks 的 10s 周期一致
    this.checkTimer = setInterval(() => {
      if (this.checking) return;
      this.checking = true;
      this.checkNetworks()
        .catch((err) => this.logger.error('Network health-check failed', err))
        .finally(() => {
          this.checking = false;
        });
    }, 10_000);
    // 健康检查定时器不应单独阻止进程退出
    this.checkTimer.unref?.();
  }

  /* ------------------------------------------------------------------ */
  /*  Provider 注册                                                      */
  /* ------------------------------------------------------------------ */

  registerProvider(provider: NetworkProvider<unknown>): void {
    this.assertOpen();
    this.providers.set(provider.type.id, provider);
    this.logger.log(`NetworkProvider registered: ${provider.type.id}`);
  }

  /* ------------------------------------------------------------------ */
  /*  INetworkManager 实现                                               */
  /* ------------------------------------------------------------------ */

  async getNetwork<T extends Network = Network>(type: NetworkType, id: string): Promise<T> {
    this.assertOpen();
    const key = this.key(type.id, id);
    let creating = this.pending.get(key);
    if (!creating) {
      const generation = this.generation(key);
      creating = this.enqueue(key, async () => {
        this.assertCurrent(key, generation);
        const networkMap = this.getNetworkStore(type.id);
        const cached = networkMap.get(id);
        if (cached) return cached;
        const network = await this.createFromConfig(type, id);
        if (!this.isCurrent(key, generation)) {
          await network.shutdown();
          throw new Error(`Network operation superseded: ${key}`);
        }
        networkMap.set(id, network);
        return network;
      });
      this.pending.set(key, creating);
      const cleanup = () => { if (this.pending.get(key) === creating) this.pending.delete(key); };
      void creating.then(cleanup, cleanup);
    }
    return (await creating) as T;
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
    this.assertOpen();
    const key = this.key(type.id, id);
    const generation = this.generation(key);
    await this.enqueue(key, async () => {
      this.assertCurrent(key, generation);
      const provider = this.requireProvider(type.id);
      const props = await this.configManager.getConfig(type, id);
      this.assertCurrent(key, generation);
      const networkMap = this.getNetworkStore(type.id);
      const existing = networkMap.get(id);
      if (!props || !props.enabled) {
        networkMap.delete(id);
        this.stopped.delete(key);
        if (existing) await existing.shutdown();
        return;
      }
      const config = await provider.createConfig(props);
      this.assertCurrent(key, generation);
      const network = existing
        ? await provider.reload(existing, config)
        : await provider.createNetwork(config);
      if (!this.isCurrent(key, generation)) {
        // The queued close owns the cached instance; only release a new, untracked result here.
        if (network !== existing) await network.shutdown();
        throw new Error(`Network operation superseded: ${key}`);
      }
      networkMap.set(id, network);
      this.stopped.delete(key);
    });
  }

  async shutdown(type: NetworkType, id: string): Promise<void> {
    if (this.closed) return this.onModuleDestroy();
    const key = this.key(type.id, id);
    this.invalidate(key);
    this.stopped.add(key);
    await this.enqueue(key, async () => {
      const network = this.store.get(type.id)?.get(id);
      if (network) await network.shutdown();
    });
  }

  async destroy(type: NetworkType, id: string): Promise<void> {
    if (this.closed) return this.onModuleDestroy();
    const key = this.key(type.id, id);
    this.invalidate(key);
    this.stopped.delete(key);
    await this.enqueue(key, async () => {
      const networkMap = this.store.get(type.id);
      const network = networkMap?.get(id);
      networkMap?.delete(id);
      if (network) await network.shutdown();
    });
  }

  onModuleDestroy(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    if (this.checkTimer) clearInterval(this.checkTimer);
    this.checkTimer = undefined;
    this.closing = (async () => {
      // Pending factories/reloads dispose their late results before cached instances are closed.
      await Promise.allSettled(this.operations.values());
      const networks = new Set(this.getNetworks());
      this.store.clear();
      this.stopped.clear();
      this.generations.clear();
      await Promise.all([...networks].map(async network => {
        try { await network.shutdown(); } catch (err) {
          this.logger.error(`Failed to shutdown network ${network.id}`, err);
        }
      }));
    })();
    return this.closing;
  }

  /* ------------------------------------------------------------------ */
  /*  内部方法                                                           */
  /* ------------------------------------------------------------------ */

  private key(typeId: string, id: string): string {
    return JSON.stringify([typeId, id]);
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Network manager is closed');
  }

  private generation(key: string): symbol {
    let value = this.generations.get(key);
    if (!value) this.generations.set(key, value = Symbol(key));
    return value;
  }

  private invalidate(key: string): void {
    this.generations.set(key, Symbol(key));
    this.pending.delete(key);
  }

  private isCurrent(key: string, generation: symbol): boolean {
    return !this.closed && this.generations.get(key) === generation;
  }

  private assertCurrent(key: string, generation: symbol): void {
    if (!this.isCurrent(key, generation)) throw new Error(`Network operation superseded: ${key}`);
  }

  private enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(key);
    const operation = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(task);
    this.operations.set(key, operation);
    const cleanup = () => { if (this.operations.get(key) === operation) this.operations.delete(key); };
    void operation.then(cleanup, cleanup);
    return operation;
  }

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
    for (const network of this.getNetworks()) {
      if (this.closed) return;
      if (this.store.get(network.type.id)?.get(network.id) !== network) continue;
      const key = this.key(network.type.id, network.id);
      if (network.isAlive() || !network.isAutoReload() || this.stopped.has(key) || this.operations.has(key)) continue;
      try {
        await this.reload(network.type, network.id);
      } catch (err) {
        this.logger.warn(`Failed to reload network ${network.type.id}/${network.id}`, err);
      }
    }
  }
}
