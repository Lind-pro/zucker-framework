import type { Network } from './network';
import type { NetworkType } from './network-type';
import type { NetworkProperties } from './network-config';

/**
 * 网络组件提供商 SPI。
 *
 * 对应 jetlinks `NetworkProvider<P>` — 每种网络类型注册一个 Provider，
 * 负责根据配置创建/重载网络实例。
 *
 * 泛型 P 为具体的配置类型（如 TcpServerConfig、MqttClientConfig）。
 *
 * 与 jetlinks 的差异：
 * - 去掉 Reactor Mono，使用 async/Promise
 * - 去掉 ConfigMetadata（Java UI 元数据，在 TS 中用 JSON Schema 替代）
 */
export interface NetworkProvider<P = unknown> {
  /** 该 Provider 支持的网络类型 */
  readonly type: NetworkType;

  /** 根据具体配置创建网络组件 */
  createNetwork(config: P): Promise<Network>;

  /** 重载已有网络组件（热更新配置） */
  reload(network: Network, config: P): Promise<Network>;

  /**
   * 将通用 NetworkProperties 转换为具体配置对象 P。
   * 对应 jetlinks `NetworkProvider.createConfig(NetworkProperties)`。
   */
  createConfig(properties: NetworkProperties): Promise<P>;

  /**
   * 网络组件是否可被多个消费者复用。
   *
   * 例如 TCP Server 通常不可复用（一个端口只能被一个网关占用），
   * 而 HTTP Client 可复用。
   * 默认 false。
   */
  isReusable(): boolean;
}
