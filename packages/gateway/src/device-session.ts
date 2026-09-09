/**
 * 设备会话 — 对应 jetlinks DeviceSession
 *
 * 代表一个已连接设备的网络会话，负责消息的收发与状态跟踪。
 */
import type { Transport } from '@zucker-framework/network';

/**
 * 设备会话状态
 */
export enum SessionState {
  /** 会话正常，设备在线 */
  CONNECTED = 'connected',
  /** 会话已关闭 */
  CLOSED = 'closed',
  /** 会话空闲（超时告警） */
  IDLE = 'idle',
}

/**
 * 设备会话接口 — 对应 jetlinks DeviceSession
 */
export interface DeviceSession {
  /** 会话唯一 ID */
  readonly sessionId: string;
  /** 关联的设备（物）ID */
  readonly thingId: string;
  /** 所属网关 ID */
  readonly gatewayId: string;
  /** 传输协议 */
  readonly transport: Transport;
  /** 会话创建时间 */
  readonly connectTime: number;
  /** 最后活跃时间 */
  lastPingTime: number;
  /** 当前状态 */
  state: SessionState;

  /**
   * 发送下行消息（原始字节/对象）到设备
   * 对应 jetlinks DeviceSession.send()
   */
  send(payload: unknown): Promise<void>;

  /**
   * 关闭会话
   * 对应 jetlinks DeviceSession.close()
   */
  close(): Promise<void>;

  /**
   * 更新心跳
   * 对应 jetlinks DeviceSession.ping()
   */
  ping(): void;

  /**
   * 是否存活
   * 对应 jetlinks DeviceSession.isAlive()
   */
  isAlive(): boolean;
}

/**
 * 子设备会话 — 对应 jetlinks ChildDeviceSession
 *
 * 通过父设备（如网关设备）代理的子设备会话。
 */
export interface ChildDeviceSession extends DeviceSession {
  /** 父设备 ID */
  readonly parentThingId: string;
}
