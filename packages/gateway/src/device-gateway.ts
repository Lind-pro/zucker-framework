/**
 * 设备网关接口 — 对应 jetlinks DeviceGateway
 *
 * 网关是协议层（network）与业务层（things）的桥接器：
 *   - 接收设备连接，建立 DeviceSession
 *   - 调用 MessageCodec 解码上行消息，发布到消息总线
 *   - 接收下行消息，编码后通过 DeviceSession 发送给设备
 */
import { Injectable, Logger } from '@nestjs/common';
import type { ThingManager, ThingsDataService, UpstreamMessage } from '@zucker/things';
import { ThingState } from '@zucker/things';
import type { DeviceSession } from './device-session';
import { SessionState } from './device-session';
import type { ProtocolSupport, DecodeContext } from './codec';

/**
 * 网关状态
 */
export enum GatewayState {
  STARTING = 'starting',
  RUNNING = 'running',
  PAUSED = 'paused',
  STOPPED = 'stopped',
}

/**
 * 网关配置
 */
export interface DeviceGatewayConfig {
  id: string;
  name: string;
  /** 关联的 network 配置 ID */
  networkId: string;
  /** 使用的协议 ID */
  protocolId: string;
  /** 传输 schema（与 protocol.getCodec(schema) 对应）*/
  transport: string;
}

/**
 * 设备网关接口 — 对应 jetlinks DeviceGateway
 */
export interface DeviceGateway {
  readonly config: DeviceGatewayConfig;
  readonly state: GatewayState;

  /** 启动网关 */
  start(): Promise<void>;
  /** 暂停（不再接受新连接，已有连接保持）*/
  pause(): Promise<void>;
  /** 停止网关并关闭所有连接 */
  shutdown(): Promise<void>;

  /** 获取活跃会话数量 */
  getSessionCount(): number;
  /** 获取指定设备的会话 */
  getSession(thingId: string): DeviceSession | undefined;
  /** 发送下行消息到指定设备 */
  sendDownstream(thingId: string, payload: unknown): Promise<void>;
}

/**
 * 抽象网关基类 — 提供会话管理 + 消息路由公共逻辑
 * 子类只需实现协议特定的 start/pause/shutdown
 *
 * 对应 jetlinks AbstractDeviceGateway
 */
@Injectable()
export abstract class AbstractDeviceGateway implements DeviceGateway {
  protected readonly logger: Logger;
  protected readonly sessions = new Map<string, DeviceSession>();
  state: GatewayState = GatewayState.STOPPED;

  constructor(
    readonly config: DeviceGatewayConfig,
    protected readonly protocol: ProtocolSupport,
    protected readonly thingManager: ThingManager,
    protected readonly dataService: ThingsDataService,
  ) {
    this.logger = new Logger(this.constructor.name);
  }

  abstract start(): Promise<void>;
  abstract pause(): Promise<void>;
  abstract shutdown(): Promise<void>;

  getSessionCount(): number {
    return this.sessions.size;
  }

  getSession(thingId: string): DeviceSession | undefined {
    return this.sessions.get(thingId);
  }

  async sendDownstream(thingId: string, payload: unknown): Promise<void> {
    const session = this.sessions.get(thingId);
    if (!session || !session.isAlive()) {
      throw new Error(`No active session for thing: ${thingId}`);
    }
    await session.send(payload);
  }

  /**
   * 处理设备连接 — 注册会话并触发上线
   */
  protected async onSessionConnected(session: DeviceSession): Promise<void> {
    this.sessions.set(session.thingId, session);
    await this.thingManager.updateState(session.thingId, ThingState.ONLINE);
    this.logger.log(`Device connected: ${session.thingId} (session: ${session.sessionId})`);
  }

  /**
   * 处理设备断开 — 移除会话并触发离线
   */
  protected async onSessionClosed(session: DeviceSession): Promise<void> {
    this.sessions.delete(session.thingId);
    session.state = SessionState.CLOSED;
    await this.thingManager.updateState(session.thingId, ThingState.OFFLINE);
    this.logger.log(`Device disconnected: ${session.thingId}`);
  }

  /**
   * 处理上行原始消息 — 解码后路由到对应处理器
   * 对应 jetlinks AbstractDeviceGateway.doMessage()
   */
  protected async handleIncoming(context: DecodeContext): Promise<void> {
    const codec = this.protocol.getCodec(this.config.transport);
    if (!codec) {
      this.logger.warn(`No codec for transport: ${this.config.transport}`);
      return;
    }

    let messages: UpstreamMessage[];
    try {
      messages = await codec.decode(context);
    } catch (err) {
      this.logger.error(`Decode error for device ${context.session.thingId}:`, err);
      return;
    }

    for (const msg of messages) {
      await this.routeMessage(msg);
    }
  }

  /**
   * 将解码后的消息路由到业务处理 — 对应 jetlinks DeviceMessageBus.publish()
   */
  private async routeMessage(message: UpstreamMessage): Promise<void> {
    try {
      switch (message.messageType) {
        case 'Online':
          await this.thingManager.updateState(message.thingId, ThingState.ONLINE, message.timestamp);
          break;
        case 'Offline':
          await this.thingManager.updateState(message.thingId, ThingState.OFFLINE, message.timestamp);
          break;
        case 'Register':
          // 设备注册时确保实例存在
          break;
        case 'ReportProperty':
          await this.dataService.saveProperties(message);
          break;
        case 'Event':
          await this.dataService.saveEvent(message);
          break;
        case 'FunctionReply':
        case 'ReadPropertyReply':
          // 回复消息：关联等待中的下行请求（此处留给具体实现扩展）
          break;
        default:
          break;
      }
    } catch (err) {
      this.logger.error(`Failed to route message ${message.messageType} from ${message.thingId}:`, err);
    }
  }

  /**
   * 关闭所有会话
   */
  protected async closeAllSessions(): Promise<void> {
    const closing = Array.from(this.sessions.values()).map((s) => s.close().catch(() => {}));
    await Promise.all(closing);
    this.sessions.clear();
  }
}
