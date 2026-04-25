import type { NetworkType } from './network-type';

/**
 * 网络组件根接口。
 *
 * 对应 jetlinks `Network` — 所有具体网络实现（TCP Server、MQTT Client 等）
 * 的统一抽象。提供生命周期管理（shutdown / isAlive / isAutoReload）。
 */
export interface Network {
  /** 网络组件实例唯一标识 */
  readonly id: string;

  /** 网络类型 */
  readonly type: NetworkType;

  /** 关闭网络组件，释放底层资源 */
  shutdown(): Promise<void> | void;

  /** 组件是否存活 */
  isAlive(): boolean;

  /**
   * 当 isAlive() 返回 false 时，是否由 NetworkManager 自动重新加载。
   * 默认 false。
   */
  isAutoReload(): boolean;
}

/**
 * 服务端网络组件，额外暴露绑定地址。
 *
 * 对应 jetlinks `ServerNetwork`。
 */
export interface ServerNetwork extends Network {
  /** 绑定的 host:port；如未绑定返回 undefined */
  getBindAddress(): { host: string; port: number } | undefined;
}
