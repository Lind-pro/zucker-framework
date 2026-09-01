import { Module } from '@nestjs/common';
import { GatewayManager } from './gateway-manager';
import { ProtocolRegistry } from './codec';

/**
 * GatewayModule — 协议网关 NestJS 模块
 *
 * 提供：
 *   - ProtocolRegistry（协议注册表）
 *   - GatewayManager（网关生命周期管理）
 */
@Module({
  providers: [ProtocolRegistry, GatewayManager],
  exports: [ProtocolRegistry, GatewayManager],
})
export class GatewayModule {}
