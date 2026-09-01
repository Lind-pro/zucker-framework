/**
 * 传输协议抽象。
 *
 * 对应 jetlinks NetworkTransport（TCP / UDP）以及 NetworkConfig.schema
 * （http / mqtt / ws 等应用层协议）。
 *
 * 在 zucker 中将两层合并为一个 Transport 枚举 + schema 字段，
 * 使消费方只需关心一个类型。
 */

/** 底层传输协议 */
export type TransportProtocol = 'TCP' | 'UDP';

/**
 * 传输描述 — 包含底层协议 + 应用层 schema。
 *
 * 例如 MQTT over TCP: `{ protocol: 'TCP', schema: 'mqtt' }`
 */
export interface Transport {
  /** 底层协议：TCP 或 UDP */
  readonly protocol: TransportProtocol;
  /** 应用层 schema，如 http / mqtt / ws */
  readonly schema: string;
}

export function createTransport(protocol: TransportProtocol, schema: string): Transport {
  return { protocol, schema };
}

/** 常见传输常量 */
export const Transports = {
  TCP: createTransport('TCP', 'tcp'),
  UDP: createTransport('UDP', 'udp'),
  HTTP: createTransport('TCP', 'http'),
  HTTPS: createTransport('TCP', 'https'),
  MQTT: createTransport('TCP', 'mqtt'),
  MQTTS: createTransport('TCP', 'mqtts'),
  WS: createTransport('TCP', 'ws'),
  WSS: createTransport('TCP', 'wss'),
} as const;
