/**
 * 时序指标标识 — 对应 jetlinks TimeSeriesMetric
 * 提供 id + name 的标准化标识模式
 */
export interface TimeSeriesMetric {
  /** 指标唯一标识 */
  id: string;
  /** 人类可读名称 */
  name: string;
}

/**
 * 创建 TimeSeriesMetric 的工厂方法 — 对应 jetlinks TimeSeriesMetric.of()
 */
export function createMetric(id: string, name?: string): TimeSeriesMetric {
  return { id, name: name ?? id };
}

/**
 * 时序数据字段类型
 */
export enum TimeSeriesFieldType {
  INT = 'int',
  LONG = 'long',
  FLOAT = 'float',
  DOUBLE = 'double',
  STRING = 'string',
  BOOLEAN = 'boolean',
}

/**
 * 时序数据字段定义
 */
export interface TimeSeriesField {
  name: string;
  type: TimeSeriesFieldType;
  description?: string;
}

/**
 * 时间精度
 */
export enum TimePrecision {
  MILLISECOND = 'ms',
  SECOND = 's',
  MINUTE = 'min',
  HOUR = 'h',
  DAY = 'd',
}

/**
 * 时序指标元数据定义
 */
export interface TimeSeriesMetadata {
  /** 指标名称（唯一标识） */
  metric: string;
  /** 描述 */
  description?: string;
  /** 数据字段定义 */
  fields: TimeSeriesField[];
  /** 标签字段（用于过滤/分组） */
  tags: string[];
  /** 时间精度，默认毫秒 */
  precision?: TimePrecision;
}
