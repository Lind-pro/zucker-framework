// 设备会话
export type { DeviceSession, ChildDeviceSession } from './device-session';
export { SessionState } from './device-session';

// 编解码器
export type {
  MessageCodec,
  ProtocolSupport,
  DecodeContext,
  EncodeContext,
  EncodedMessage,
} from './codec';
export { ProtocolRegistry } from './codec';

// 网关基类 & 接口
export type { DeviceGateway, DeviceGatewayConfig } from './device-gateway';
export { GatewayState, AbstractDeviceGateway } from './device-gateway';

// 内置实现
export { HttpDeviceGateway } from './http-gateway';

// 网关管理器
export { GatewayManager } from './gateway-manager';

// NestJS 模块
export { GatewayModule } from './gateway.module';
