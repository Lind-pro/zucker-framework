/**
 * 消息编解码器抽象。
 *
 * 对应 jetlinks `DeviceMessageCodec` 的通用子集 — 去掉了 IoT 设备
 * 消息特定部分，保留通用的 encode / decode / transport 关联。
 *
 * 在 zucker 中，Codec 用于任意协议的消息序列化/反序列化，
 * 例如 MQTT payload 解析、TCP 帧编解码等。
 */

import type { Transport } from './transport';

/**
 * 编解码上下文 — 携带编解码时可能需要的环境信息。
 */
export interface CodecContext {
  /** 当前网络组件 ID */
  readonly networkId?: string;
  /** 额外上下文 KV */
  readonly attributes: Record<string, unknown>;
}

/**
 * 消息编解码器。
 *
 * 泛型参数：
 * - TEncoded  : 编码后的格式（如 Buffer、string）
 * - TDecoded  : 解码后的业务对象
 */
export interface Codec<TEncoded = Buffer, TDecoded = unknown> {
  /** 编解码器标识 */
  readonly id: string;

  /** 该编解码器绑定的传输协议 */
  readonly transport: Transport;

  /** 将业务对象编码为传输格式 */
  encode(message: TDecoded, context?: CodecContext): Promise<TEncoded> | TEncoded;

  /** 将传输格式解码为业务对象 */
  decode(payload: TEncoded, context?: CodecContext): Promise<TDecoded> | TDecoded;
}

/**
 * JSON 编解码器 — 最常见的实现，将对象序列化为 JSON Buffer。
 */
export class JsonCodec<T = unknown> implements Codec<Buffer, T> {
  readonly id: string;
  readonly transport: Transport;

  constructor(id: string, transport: Transport) {
    this.id = id;
    this.transport = transport;
  }

  encode(message: T): Buffer {
    return Buffer.from(JSON.stringify(message));
  }

  decode(payload: Buffer): T {
    return JSON.parse(payload.toString('utf-8')) as T;
  }
}
