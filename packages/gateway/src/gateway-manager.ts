/**
 * 网关管理器 — 对应 jetlinks DeviceGatewayManager
 *
 * 统一管理所有注册的网关实例：启动、停止、查询状态。
 */
import { Injectable, Logger } from '@nestjs/common';
import type { DeviceGateway } from './device-gateway';
import { GatewayState } from './device-gateway';
import { ProtocolRegistry } from './codec';

@Injectable()
export class GatewayManager {
  private readonly logger = new Logger(GatewayManager.name);
  private readonly gateways = new Map<string, DeviceGateway>();

  constructor(readonly protocolRegistry: ProtocolRegistry) {}

  register(gateway: DeviceGateway): void {
    if (this.gateways.has(gateway.config.id)) {
      throw new Error(`Gateway already registered: ${gateway.config.id}`);
    }
    this.gateways.set(gateway.config.id, gateway);
    this.logger.log(`Gateway registered: ${gateway.config.id} (${gateway.config.name})`);
  }

  unregister(gatewayId: string): void {
    this.gateways.delete(gatewayId);
  }

  get(gatewayId: string): DeviceGateway | undefined {
    return this.gateways.get(gatewayId);
  }

  getAll(): DeviceGateway[] {
    return Array.from(this.gateways.values());
  }

  /** 启动所有已注册的网关 */
  async startAll(): Promise<void> {
    const results = await Promise.allSettled(
      Array.from(this.gateways.values()).map((g) => g.start()),
    );
    for (const [i, result] of results.entries()) {
      const gateway = Array.from(this.gateways.values())[i];
      if (result.status === 'rejected') {
        this.logger.error(`Failed to start gateway ${gateway?.config.id}:`, result.reason);
      }
    }
  }

  /** 停止所有网关 */
  async shutdownAll(): Promise<void> {
    await Promise.allSettled(
      Array.from(this.gateways.values()).map((g) => g.shutdown()),
    );
  }

  /** 汇总统计 */
  getSummary(): {
    total: number;
    running: number;
    stopped: number;
    totalSessions: number;
  } {
    const all = Array.from(this.gateways.values());
    return {
      total: all.length,
      running: all.filter((g) => g.state === GatewayState.RUNNING).length,
      stopped: all.filter((g) => g.state === GatewayState.STOPPED).length,
      totalSessions: all.reduce((sum, g) => sum + g.getSessionCount(), 0),
    };
  }
}
