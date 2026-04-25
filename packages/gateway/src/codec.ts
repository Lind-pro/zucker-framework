/**
 * 消息编解码器 — 对应 jetlinks ProtocolSupport / MessageCodec
 *
 * 负责原始协议消息 ↔ ThingMessage 的互转。
 * 不同协议（MQTT/HTTP/TCP）提供不同的 Codec 实现。
 */
import type { ThingMessage, UpstreamMessage, DownstreamMessage } from '@zucker/things';
import type { DeviceSession } from './device-session';

/**
 * 上行消息解码上下文 — 对应 jetlinks MessageDecodeContext
 */
export interface DecodeContext {
  /** 接收到的原始消息 */
  payload: unknown;
  /** 原始主题/路径/端点（MQTT topic、HTTP path 等） */
  topic?: string;
  /** 请求头/消息头 */
  headers?: Record<string, string>;
  /** 关联的设备会话 */
  session: DeviceSession;
}

/**
 * 下行消息编码上下文 — 对应 jetlinks MessageEncodeContext
 */
export interface EncodeContext {
  /** 要发送的平台消息 */
  message: DownstreamMessage;
  /** 关联的设备会话 */
  session: DeviceSession;
}

/**
 * 编码结果
 */
export interface EncodedMessage {
  /** 编码后的载荷 */
  payload: unknown;
  /** 目标主题/路径 */
  topic?: string;
  /** 附加头信息 */
  headers?: Record<string, string>;
}

/**
 * 消息编解码器接口 — 对应 jetlinks DeviceMessageCodec / ProtocolSupport
 */
export interface MessageCodec {
  /**
   * 解码上行消息（原始 → ThingMessage[]）
   * 对应 jetlinks DeviceMessageCodec.decode()
   * 一条原始消息可能解析出多条逻辑消息（如批量属性上报）
   */
  decode(context: DecodeContext): Promise<UpstreamMessage[]>;

  /**
   * 编码下行消息（ThingMessage → 原始）
   * 对应 jetlinks DeviceMessageCodec.encode()
   */
  encode(context: EncodeContext): Promise<EncodedMessage>;
}

/**
 * 协议支持描述 — 对应 jetlinks ProtocolSupport
 */
export interface ProtocolSupport {
  /** 协议唯一 ID */
  readonly id: string;
  /** 协议名称 */
  readonly name: string;
  /** 支持的传输协议 schema 列表，如 ['mqtt', 'http', 'tcp'] */
  readonly transports: string[];
  /** 获取对应传输协议的编解码器 */
  getCodec(transport: string): MessageCodec | undefined;
}

/**
 * 协议注册表 — 对应 jetlinks ProtocolSupportManager
 */
export class ProtocolRegistry {
  private readonly protocols = new Map<string, ProtocolSupport>();

  register(protocol: ProtocolSupport): void {
    this.protocols.set(protocol.id, protocol);
  }

  unregister(id: string): void {
    this.protocols.delete(id);
  }

  get(id: string): ProtocolSupport | undefined {
    return this.protocols.get(id);
  }

  getAll(): ProtocolSupport[] {
    return Array.from(this.protocols.values());
  }
}
