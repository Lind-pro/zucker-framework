/**
 * 物模型元数据 — 对应 jetlinks ThingMetadata / DeviceMetadata
 *
 * 定义一类物（设备）的属性、事件、功能三元素。
 */
import type { DataType } from './data-type';

/**
 * 属性读写权限 — 对应 jetlinks PropertyMetadata.AccessMode
 */
export enum PropertyAccessMode {
  /** 只读 */
  READ = 'r',
  /** 只写 */
  WRITE = 'w',
  /** 读写 */
  READ_WRITE = 'rw',
}

/**
 * 属性元数据 — 对应 jetlinks PropertyMetadata
 */
export interface PropertyMetadata {
  /** 属性唯一标识 */
  id: string;
  /** 属性名称 */
  name: string;
  /** 数据类型 */
  dataType: DataType;
  /** 读写权限，默认可读写 */
  accessMode?: PropertyAccessMode;
  /** 描述 */
  description?: string;
  /** 存储到时序数据库时的指标名（默认使用 thingType.id） */
  storageMetric?: string;
  /** 是否忽略存储 */
  ignoreStorage?: boolean;
  /** 扩展属性 */
  expands?: Record<string, unknown>;
}

/**
 * 功能参数 — 对应 jetlinks FunctionMetadata.Parameter / InputOutput
 */
export interface FunctionParameter {
  id: string;
  name: string;
  dataType: DataType;
  description?: string;
}

/**
 * 功能元数据 — 对应 jetlinks FunctionMetadata
 */
export interface FunctionMetadata {
  id: string;
  name: string;
  /** 输入参数 */
  inputs: FunctionParameter[];
  /** 输出参数（返回值定义） */
  output?: FunctionParameter[];
  /** 是否为异步功能（下行指令，无立即返回值） */
  async?: boolean;
  description?: string;
}

/**
 * 事件级别 — 对应 jetlinks EventMetadata.EventType
 */
export enum EventLevel {
  /** 普通上报 */
  OTHER = 'other',
  /** 告警 */
  WARN = 'warn',
  /** 故障 */
  ERROR = 'error',
}

/**
 * 事件元数据 — 对应 jetlinks EventMetadata
 */
export interface EventMetadata {
  id: string;
  name: string;
  /** 事件携带的数据结构 */
  valueType: DataType;
  /** 事件级别 */
  level?: EventLevel;
  description?: string;
  /** 是否存储到时序数据库 */
  storeInTimeSeries?: boolean;
}

/**
 * 物模型元数据 — 对应 jetlinks ThingMetadata
 */
export interface ThingMetadata {
  /** 属性列表 */
  properties: PropertyMetadata[];
  /** 功能列表 */
  functions: FunctionMetadata[];
  /** 事件列表 */
  events: EventMetadata[];
  /** 标签列表（自定义键值对，不参与时序存储） */
  tags?: PropertyMetadata[];
}

/**
 * 合并两份 ThingMetadata — 对应 jetlinks SimpleThingMetadata.merge()
 *
 * 后者属性覆盖前者（以 id 为键）。
 */
export function mergeMetadata(base: ThingMetadata, patch: Partial<ThingMetadata>): ThingMetadata {
  const mergeList = <T extends { id: string }>(a: T[], b: T[] = []): T[] => {
    const map = new Map(a.map((i) => [i.id, i]));
    for (const item of b) {
      map.set(item.id, item);
    }
    return Array.from(map.values());
  };

  return {
    properties: mergeList(base.properties, patch.properties),
    functions: mergeList(base.functions, patch.functions),
    events: mergeList(base.events, patch.events),
    tags: mergeList(base.tags ?? [], patch.tags),
  };
}

/**
 * 工厂：从简单描述创建 ThingMetadata
 */
export function createMetadata(partial: Partial<ThingMetadata> = {}): ThingMetadata {
  return {
    properties: partial.properties ?? [],
    functions: partial.functions ?? [],
    events: partial.events ?? [],
    tags: partial.tags ?? [],
  };
}
