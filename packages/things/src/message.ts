/**
 * 物消息体系 — 对应 jetlinks ThingMessage / DeviceMessage
 *
 * 所有设备上行/下行消息的类型定义。
 * 设计原则：消息类型通过 messageType 字符串区分，便于序列化和路由。
 */

export type ThingMessageType =
  // 上行：设备 → 平台
  | 'ReportProperty'
  | 'Event'
  | 'FunctionReply'
  | 'Register'
  | 'Unregister'
  | 'Online'
  | 'Offline'
  | 'ReportTags'
  | 'UpdateMetadata'
  | 'StateCheck'
  | 'ReadPropertyReply'
  // 下行：平台 → 设备
  | 'ReadProperty'
  | 'WriteProperty'
  | 'FunctionInvoke';

/**
 * 消息基类 — 对应 jetlinks ThingMessage
 */
export interface ThingMessage {
  /** 消息类型 */
  messageType: ThingMessageType;
  /** 消息 ID，用于请求-响应关联 */
  messageId: string;
  /** 物（设备）ID */
  thingId: string;
  /** 物类型 ID */
  thingType: string;
  /** 时间戳（毫秒） */
  timestamp: number;
  /** 消息头（扩展元数据） */
  headers?: Record<string, unknown>;
}

// ========== 上行消息 ==========

/**
 * 属性上报 — 对应 jetlinks ReportPropertyMessage
 */
export interface ReportPropertyMessage extends ThingMessage {
  messageType: 'ReportProperty';
  /** 属性键值对，key 为属性 ID */
  properties: Record<string, unknown>;
  /** 各属性的上报时间（可选，key 与 properties 一致） */
  propertySourceTimes?: Record<string, number>;
  /** 各属性的状态（可选，'success' | 'error' | 'noReport'） */
  propertyStates?: Record<string, string>;
}

/**
 * 事件上报 — 对应 jetlinks EventMessage
 */
export interface EventMessage extends ThingMessage {
  messageType: 'Event';
  /** 事件 ID */
  event: string;
  /** 事件数据 */
  data: unknown;
}

/**
 * 功能调用回复 — 对应 jetlinks FunctionInvokeReplyMessage
 */
export interface FunctionReplyMessage extends ThingMessage {
  messageType: 'FunctionReply';
  /** 关联的下行消息 ID */
  correlationKey?: string;
  /** 功能 ID */
  functionId: string;
  /** 返回值 */
  output?: unknown;
  /** 是否成功 */
  success: boolean;
  /** 错误信息 */
  errorMessage?: string;
  /** 错误码 */
  errorCode?: string;
}

/**
 * 设备注册 — 对应 jetlinks RegisterMessage
 */
export interface RegisterMessage extends ThingMessage {
  messageType: 'Register';
}

/**
 * 设备注销 — 对应 jetlinks UnRegisterMessage
 */
export interface UnregisterMessage extends ThingMessage {
  messageType: 'Unregister';
}

/**
 * 设备上线 — 对应 jetlinks DeviceOnlineMessage
 */
export interface OnlineMessage extends ThingMessage {
  messageType: 'Online';
}

/**
 * 设备离线 — 对应 jetlinks DeviceOfflineMessage
 */
export interface OfflineMessage extends ThingMessage {
  messageType: 'Offline';
}

/**
 * 标签上报 — 对应 jetlinks ReportTagsMessage
 */
export interface ReportTagsMessage extends ThingMessage {
  messageType: 'ReportTags';
  tags: Record<string, unknown>;
}

/**
 * 读属性回复 — 对应 jetlinks ReadPropertyMessageReply
 */
export interface ReadPropertyReplyMessage extends ThingMessage {
  messageType: 'ReadPropertyReply';
  correlationKey?: string;
  properties: Record<string, unknown>;
  success: boolean;
  errorMessage?: string;
}

// ========== 下行消息 ==========

/**
 * 读属性指令 — 对应 jetlinks ReadPropertyMessage
 */
export interface ReadPropertyMessage extends ThingMessage {
  messageType: 'ReadProperty';
  /** 要读取的属性 ID 列表 */
  properties: string[];
}

/**
 * 写属性指令 — 对应 jetlinks WritePropertyMessage
 */
export interface WritePropertyMessage extends ThingMessage {
  messageType: 'WriteProperty';
  properties: Record<string, unknown>;
}

/**
 * 功能调用指令 — 对应 jetlinks FunctionInvokeMessage
 */
export interface FunctionInvokeMessage extends ThingMessage {
  messageType: 'FunctionInvoke';
  /** 功能 ID */
  functionId: string;
  /** 输入参数 */
  inputs: Record<string, unknown>;
  /** 是否同步等待回复 */
  sync?: boolean;
}

export type UpstreamMessage =
  | ReportPropertyMessage
  | EventMessage
  | FunctionReplyMessage
  | RegisterMessage
  | UnregisterMessage
  | OnlineMessage
  | OfflineMessage
  | ReportTagsMessage
  | ReadPropertyReplyMessage;

export type DownstreamMessage =
  | ReadPropertyMessage
  | WritePropertyMessage
  | FunctionInvokeMessage;

/**
 * 创建消息 ID — 对应 jetlinks IDGenerator.SNOW_FLAKE_STRING
 */
export function createMessageId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * 创建属性上报消息
 */
export function createReportPropertyMessage(
  thingId: string,
  thingType: string,
  properties: Record<string, unknown>,
  extra?: Partial<ReportPropertyMessage>,
): ReportPropertyMessage {
  return {
    messageType: 'ReportProperty',
    messageId: createMessageId(),
    thingId,
    thingType,
    timestamp: Date.now(),
    properties,
    ...extra,
  };
}

/**
 * 创建事件消息
 */
export function createEventMessage(
  thingId: string,
  thingType: string,
  event: string,
  data: unknown,
): EventMessage {
  return {
    messageType: 'Event',
    messageId: createMessageId(),
    thingId,
    thingType,
    timestamp: Date.now(),
    event,
    data,
  };
}
