/**
 * 物类型 & 物实例 — 对应 jetlinks ThingType / Thing
 *
 * ThingType  = 设备产品（定义一类设备的元数据模板）
 * Thing      = 设备实例（具体的一台设备）
 */
import type { ThingMetadata } from './metadata';

/**
 * 物类型 — 对应 jetlinks ThingType / ProductInfo
 */
export interface ThingType {
  /** 类型唯一 ID（如 product ID） */
  id: string;
  /** 名称 */
  name: string;
  /** 物模型元数据 */
  metadata: ThingMetadata;
  /** 协议（protocol ID，用于选择对应的网关解码器） */
  protocol?: string;
  /** 传输方式（对应 network Transport） */
  transport?: string;
  /** 是否启用 */
  enabled?: boolean;
  /** 扩展属性 */
  extra?: Record<string, unknown>;
}

/**
 * 物状态 — 对应 jetlinks DeviceState
 */
export enum ThingState {
  /** 未激活（从未在线） */
  INACTIVE = 'notActive',
  /** 离线 */
  OFFLINE = 'offline',
  /** 在线 */
  ONLINE = 'online',
}

/**
 * 物实例 — 对应 jetlinks Thing / DeviceInfo
 */
export interface Thing {
  /** 实例唯一 ID */
  id: string;
  /** 名称 */
  name: string;
  /** 所属物类型 ID */
  thingTypeId: string;
  /** 当前状态 */
  state: ThingState;
  /** 上次在线时间戳 */
  onlineTime?: number;
  /** 上次离线时间戳 */
  offlineTime?: number;
  /** 自定义标签（非时序属性） */
  tags?: Record<string, unknown>;
  /** 实例级元数据覆盖（优先于 ThingType 的 metadata） */
  metadataPatch?: Partial<ThingMetadata>;
  /** 所属父设备 ID（子设备场景） */
  parentId?: string;
  /** 扩展属性 */
  extra?: Record<string, unknown>;
}

/**
 * 物管理器接口 — 对应 jetlinks ThingManager / DeviceRegistry
 */
export interface ThingManager {
  /** 获取物类型 */
  getThingType(typeId: string): Promise<ThingType | undefined>;
  /** 注册物类型 */
  registerThingType(type: ThingType): Promise<void>;

  /** 获取物实例 */
  getThing(thingId: string): Promise<Thing | undefined>;
  /** 注册/更新物实例 */
  registerThing(thing: Thing): Promise<void>;
  /** 注销物实例 */
  unregisterThing(thingId: string): Promise<void>;

  /** 更新物状态 */
  updateState(thingId: string, state: ThingState, timestamp?: number): Promise<void>;

  /** 获取物实例的有效元数据（合并 ThingType + 实例覆盖） */
  getEffectiveMetadata(thingId: string): Promise<ThingMetadata | undefined>;
}
