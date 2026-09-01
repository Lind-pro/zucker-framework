import type { Transport } from './transport';

/**
 * 网络组件配置基础接口。
 *
 * 对应 jetlinks `NetworkConfig` — 抽象出所有网络组件共有的配置属性。
 */
export interface NetworkConfig {
  /** 配置唯一标识 */
  readonly id: string;

  /** 传输协议 */
  readonly transport: Transport;

  /** 是否启用 TLS/DTLS 安全加密 */
  readonly secure: boolean;

  /** 安全证书标识（secure 为 true 时必须） */
  readonly certId?: string;
}

/**
 * 服务端网络配置。
 *
 * 对应 jetlinks `ServerNetworkConfig`。
 */
export interface ServerNetworkConfig extends NetworkConfig {
  /** 监听地址 */
  readonly host: string;
  /** 监听端口 */
  readonly port: number;
}

/**
 * 客户端网络配置。
 *
 * 对应 jetlinks `ClientNetworkConfig`。
 */
export interface ClientNetworkConfig extends NetworkConfig {
  /** 远端地址 */
  readonly remoteHost: string;
  /** 远端端口 */
  readonly remotePort: number;
}

/**
 * 通用可序列化的网络属性，对应 jetlinks `NetworkProperties`。
 *
 * 与 jetlinks 完全对齐：type + configurations map 的组合
 * 让 NetworkProvider 可以按需反序列化成具体 Config。
 */
export interface NetworkProperties {
  /** 配置 ID */
  id: string;
  /** 网络类型标识 */
  type: string;
  /** 配置名称 */
  name: string;
  /** 是否启用 */
  enabled: boolean;
  /** 自由 KV 配置 — 不同网络类型内容不同 */
  configurations: Record<string, unknown>;
}
