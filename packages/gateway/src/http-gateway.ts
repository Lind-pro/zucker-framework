/**
 * HTTP 设备网关示例实现 — 对应 jetlinks HttpServerDeviceGateway
 *
 * 通过 HTTP POST 接收设备上报消息。
 * 这是一个示例实现，展示如何继承 AbstractDeviceGateway。
 * 实际项目中应对接 @zucker-framework/network 提供的 HTTP Server。
 */
import { Injectable } from '@nestjs/common';
import type { ThingManager, ThingsDataService } from '@zucker-framework/things';
import {
  AbstractDeviceGateway,
  GatewayState,
  type DeviceGatewayConfig,
} from './device-gateway';
import type { ProtocolSupport } from './codec';
import { SessionState, type DeviceSession } from './device-session';
import { Transports, type Transport } from '@zucker-framework/network';

/**
 * HTTP 会话（无状态，每次请求创建一个临时会话）
 */
class HttpDeviceSession implements DeviceSession {
  readonly sessionId: string;
  readonly thingId: string;
  readonly gatewayId: string;
  readonly transport: Transport = Transports.HTTP;
  readonly connectTime: number = Date.now();
  lastPingTime: number = Date.now();
  state: SessionState = SessionState.CONNECTED;

  private readonly sendFn: (payload: unknown) => Promise<void>;

  constructor(
    thingId: string,
    gatewayId: string,
    sendFn: (payload: unknown) => Promise<void>,
  ) {
    this.sessionId = `http-${thingId}-${Date.now()}`;
    this.thingId = thingId;
    this.gatewayId = gatewayId;
    this.sendFn = sendFn;
  }

  async send(payload: unknown): Promise<void> {
    await this.sendFn(payload);
  }

  async close(): Promise<void> {
    this.state = SessionState.CLOSED;
  }

  ping(): void {
    this.lastPingTime = Date.now();
  }

  isAlive(): boolean {
    return this.state === SessionState.CONNECTED;
  }
}

/**
 * HTTP 网关实现
 *
 * 用法：
 * ```typescript
 * const gateway = new HttpDeviceGateway(config, protocol, thingManager, dataService);
 * await gateway.start();
 *
 * // 当收到 HTTP 请求时：
 * await gateway.handleRequest('device-001', requestBody);
 * ```
 */
@Injectable()
export class HttpDeviceGateway extends AbstractDeviceGateway {
  constructor(
    config: DeviceGatewayConfig,
    protocol: ProtocolSupport,
    thingManager: ThingManager,
    dataService: ThingsDataService,
  ) {
    super(config, protocol, thingManager, dataService);
  }

  async start(): Promise<void> {
    this.state = GatewayState.RUNNING;
    this.logger.log(`HTTP gateway started: ${this.config.id}`);
  }

  async pause(): Promise<void> {
    this.state = GatewayState.PAUSED;
  }

  async shutdown(): Promise<void> {
    await this.closeAllSessions();
    this.state = GatewayState.STOPPED;
    this.logger.log(`HTTP gateway stopped: ${this.config.id}`);
  }

  /**
   * 处理来自设备的 HTTP 请求
   * 由 NestJS Controller 调用
   *
   * @param thingId 设备 ID（从路径参数或认证信息中提取）
   * @param body 请求体
   */
  async handleRequest(thingId: string, body: unknown): Promise<void> {
    if (this.state !== GatewayState.RUNNING) {
      throw new Error(`Gateway ${this.config.id} is not running`);
    }

    // HTTP 是无状态的，每次请求创建临时会话
    const session = new HttpDeviceSession(
      thingId,
      this.config.id,
      async () => { /* HTTP 场景下行通过响应体发送 */ },
    );

    await this.onSessionConnected(session);
    try {
      await this.handleIncoming({
        payload: body,
        session,
      });
    } finally {
      await this.onSessionClosed(session);
    }
  }
}
