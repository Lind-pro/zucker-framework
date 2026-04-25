/**
 * 时间间隔单位 — 对应 jetlinks IntervalUnit
 */
export enum IntervalUnit {
  MILLIS = 'S',
  SECONDS = 's',
  MINUTES = 'm',
  HOURS = 'h',
  DAYS = 'd',
  WEEKS = 'w',
  MONTHS = 'M',
  QUARTER = 'q',
  YEARS = 'y',
}

/**
 * 时间间隔 — 对应 jetlinks Interval
 *
 * 解析如 "1d", "30m", "1h" 等时间间隔表达式。
 *
 * @example
 * ```ts
 * const interval = Interval.of('1h');
 * interval.toMillis(); // 3600000
 * interval.round(timestamp); // 对齐到整小时
 * ```
 */
export class Interval {
  readonly value: number;
  readonly unit: IntervalUnit;

  private constructor(value: number, unit: IntervalUnit) {
    this.value = value;
    this.unit = unit;
  }

  static of(expr: string): Interval {
    const match = expr.match(/^(-?\d+(?:\.\d+)?)([a-zA-Z]+)$/);
    if (!match) {
      throw new Error(`Cannot parse interval expression: ${expr}`);
    }
    const value = Number(match[1]);
    const unitStr = match[2];

    const unitMap: Record<string, IntervalUnit> = {
      S: IntervalUnit.MILLIS,
      s: IntervalUnit.SECONDS,
      m: IntervalUnit.MINUTES,
      h: IntervalUnit.HOURS,
      d: IntervalUnit.DAYS,
      w: IntervalUnit.WEEKS,
      M: IntervalUnit.MONTHS,
      q: IntervalUnit.QUARTER,
      y: IntervalUnit.YEARS,
    };
    const unit = unitMap[unitStr];
    if (!unit) {
      throw new Error(`Unsupported interval unit: ${unitStr}`);
    }
    return new Interval(value, unit);
  }

  static ofSeconds(n: number): Interval { return new Interval(n, IntervalUnit.SECONDS); }
  static ofMinutes(n: number): Interval { return new Interval(n, IntervalUnit.MINUTES); }
  static ofHours(n: number): Interval { return new Interval(n, IntervalUnit.HOURS); }
  static ofDays(n: number): Interval { return new Interval(n, IntervalUnit.DAYS); }
  static ofMonths(n: number): Interval { return new Interval(n, IntervalUnit.MONTHS); }

  /** 转换为毫秒 — 对应 jetlinks Interval.toMillis() */
  toMillis(): number {
    switch (this.unit) {
      case IntervalUnit.MILLIS: return this.value;
      case IntervalUnit.SECONDS: return this.value * 1000;
      case IntervalUnit.MINUTES: return this.value * 60 * 1000;
      case IntervalUnit.HOURS: return this.value * 3600 * 1000;
      case IntervalUnit.DAYS: return this.value * 86400 * 1000;
      case IntervalUnit.WEEKS: return this.value * 7 * 86400 * 1000;
      case IntervalUnit.MONTHS: return this.value * 30 * 86400 * 1000; // approximate
      case IntervalUnit.QUARTER: return this.value * 91 * 86400 * 1000; // approximate
      case IntervalUnit.YEARS: return this.value * 365 * 86400 * 1000; // approximate
    }
  }

  /** 对齐时间戳到间隔边界 — 对应 jetlinks Interval.round() */
  round(timestamp: number): number {
    const ms = this.toMillis();
    return Math.floor(timestamp / ms) * ms;
  }

  toString(): string {
    return `${this.value}${this.unit}`;
  }
}

/**
 * 时序数据点
 */
export interface TimeSeriesData {
  /** 时间戳（毫秒） */
  timestamp: number;
  /** 标签值 */
  tags: Record<string, string>;
  /** 数据字段值 */
  values: Record<string, number | string | boolean>;
}

/**
 * 类型安全的值访问器 — 对应 jetlinks ValueObject 的 getInt/getLong/getString 等方法
 *
 * 在 TypeScript 中通过工具函数提供类似 Java ValueObject 接口的类型安全访问。
 */
export const TimeSeriesDataAccessor = {
  /** 获取数值字段 — 对应 jetlinks ValueObject.getInt/getLong/getDouble */
  getNumber(data: TimeSeriesData, name: string, defaultValue?: number): number | undefined {
    const v = data.values[name];
    if (typeof v === 'number') return v;
    if (v === undefined || v === null) return defaultValue;
    const n = Number(v);
    return isNaN(n) ? defaultValue : n;
  },

  /** 获取字符串字段 — 对应 jetlinks ValueObject.getString */
  getString(data: TimeSeriesData, name: string, defaultValue?: string): string | undefined {
    const v = data.values[name];
    if (typeof v === 'string') return v || defaultValue;
    if (v === undefined || v === null) return defaultValue;
    return String(v);
  },

  /** 获取布尔字段 — 对应 jetlinks ValueObject.getBoolean */
  getBoolean(data: TimeSeriesData, name: string, defaultValue?: boolean): boolean | undefined {
    const v = data.values[name];
    if (typeof v === 'boolean') return v;
    if (v === undefined || v === null) return defaultValue;
    if (v === 'true' || v === 1) return true;
    if (v === 'false' || v === 0) return false;
    return defaultValue;
  },

  /** 获取所有值的 Map — 对应 jetlinks ValueObject.values() / TimeSeriesData.getData() */
  getData(data: TimeSeriesData): Record<string, number | string | boolean> {
    return data.values;
  },
};

/**
 * 时序查询条件
 */
export interface TimeSeriesQuery {
  /** 指标名称 */
  metric: string;
  /** 起始时间（毫秒） */
  from: number;
  /** 结束时间（毫秒） */
  to: number;
  /** 标签过滤 */
  tags?: Record<string, string>;
  /** 返回条数限制 */
  limit?: number;
  /** 排序方向 */
  order?: 'asc' | 'desc';
}

/**
 * 聚合类型 — 对应 jetlinks Aggregation 枚举
 */
export enum AggregationType {
  COUNT = 'count',
  SUM = 'sum',
  AVG = 'avg',
  MIN = 'min',
  MAX = 'max',
  /** 取第一条记录 */
  FIRST = 'first',
  /** 取第一条记录（别名） — 对应 jetlinks Aggregation.TOP */
  TOP = 'top',
  /** 去重计数 */
  DISTINCT_COUNT = 'distinct_count',
  /** 不聚合 */
  NONE = 'none',
}

/**
 * 聚合列定义 — 对应 jetlinks AggregationColumn
 * 支持在一次查询中聚合多个字段
 */
export interface AggregationColumn {
  /** 字段名 */
  property: string;
  /** 结果别名 */
  alias?: string;
  /** 聚合方式 */
  aggregation: AggregationType;
  /** 默认值（无数据时返回） */
  defaultValue?: number;
}

/**
 * 聚合查询
 */
export interface AggregationQuery extends TimeSeriesQuery {
  /** 聚合类型（单列聚合时使用） */
  aggregation: AggregationType;
  /** 聚合字段（单列聚合时使用） */
  field: string;
  /** 时间窗口（毫秒） */
  interval?: number;
  /** 按标签分组 */
  groupBy?: string[];
  /** 多列聚合定义 — 对应 jetlinks AggregationQueryParam.aggColumns */
  columns?: AggregationColumn[];
}

/**
 * 聚合结果 — 对应 jetlinks AggregationData
 */
export interface AggregationResult {
  /** 时间窗口起始 */
  timestamp?: number;
  /** 分组标签值 */
  tags?: Record<string, string>;
  /** 单列聚合值 */
  value: number;
  /** 多列聚合结果（列别名 -> 值） */
  values?: Record<string, number>;
}

/**
 * 合并两个 AggregationResult — 对应 jetlinks AggregationData.merge()
 *
 * 将 another 的 values 合并到 base 中，返回新的结果对象。
 */
export function mergeAggregationResult(
  base: AggregationResult,
  another: AggregationResult,
): AggregationResult {
  return {
    ...base,
    values: { ...base.values, ...another.values },
  };
}

/**
 * 分页结果 — 对应 jetlinks PagerResult
 */
export interface PagerResult<T> {
  /** 总记录数 */
  total: number;
  /** 当前页数据 */
  data: T[];
  /** 当前页码（0-based） */
  pageIndex: number;
  /** 每页大小 */
  pageSize: number;
}

/**
 * 时序数据服务接口 — 针对单个指标的 CRUD 操作
 * 对应 jetlinks TimeSeriesService
 */
export interface TimeSeriesService {
  save(data: TimeSeriesData): Promise<void>;
  saveBatch(data: TimeSeriesData[]): Promise<void>;

  /**
   * 提交数据（延迟写入） — 对应 jetlinks TimeSeriesService.commit()
   *
   * 数据不会立即持久化，由实现决定何时 flush。
   * 适用于高吞吐场景下的批量写入优化。
   * 默认实现退化为即时 save。
   */
  commit?(data: TimeSeriesData | TimeSeriesData[]): Promise<void>;

  query(query: TimeSeriesQuery): Promise<TimeSeriesData[]>;
  /** 跨多个查询条件合并查询 — 对应 jetlinks multiQuery */
  multiQuery?(queries: TimeSeriesQuery[]): Promise<TimeSeriesData[]>;
  /** 查询数量 — 对应 jetlinks count() */
  count(query: TimeSeriesQuery): Promise<number>;

  /**
   * 分页查询 — 对应 jetlinks TimeSeriesService.queryPager()
   *
   * 返回总数 + 当前页数据的复合结构。
   */
  queryPager?(query: TimeSeriesQuery, pageIndex?: number, pageSize?: number): Promise<PagerResult<TimeSeriesData>>;

  aggregate(query: AggregationQuery): Promise<AggregationResult[]>;
  /** 删除指定时间范围内的数据 */
  deleteByRange?(from: number, to: number, tags?: Record<string, string>): Promise<number>;
}

/**
 * 聚合查询构建器 — 对应 jetlinks AggregationQueryParam 的链式 API
 *
 * 提供与 Java 版一致的流式构建方式：
 * ```ts
 * AggregationQueryBuilder.of('cpu_metrics')
 *   .sum('usage')
 *   .avg('temperature', 'avgTemp')
 *   .from(startTime)
 *   .to(endTime)
 *   .groupBy('host')
 *   .limit(100)
 *   .build()
 * ```
 */
export class AggregationQueryBuilder {
  private readonly query: AggregationQuery;

  private constructor(metric: string) {
    this.query = {
      metric,
      from: 0,
      to: Date.now(),
      aggregation: AggregationType.NONE,
      field: '',
      columns: [],
    };
  }

  static of(metric: string): AggregationQueryBuilder {
    return new AggregationQueryBuilder(metric);
  }

  from(timestamp: number | Date): this {
    this.query.from = typeof timestamp === 'number' ? timestamp : timestamp.getTime();
    return this;
  }

  to(timestamp: number | Date): this {
    this.query.to = typeof timestamp === 'number' ? timestamp : timestamp.getTime();
    return this;
  }

  /** 添加聚合列 — 对应 jetlinks AggregationQueryParam.agg() */
  agg(property: string, aggregation: AggregationType, alias?: string, defaultValue?: number): this {
    this.query.columns!.push({
      property,
      alias: alias ?? property,
      aggregation,
      defaultValue,
    });
    return this;
  }

  /** 对应 jetlinks AggregationQueryParam.sum() */
  sum(property: string, alias?: string): this {
    return this.agg(property, AggregationType.SUM, alias);
  }

  /** 对应 jetlinks AggregationQueryParam.avg() */
  avg(property: string, alias?: string): this {
    return this.agg(property, AggregationType.AVG, alias);
  }

  /** 对应 jetlinks AggregationQueryParam.count() */
  count(property: string, alias?: string): this {
    return this.agg(property, AggregationType.COUNT, alias);
  }

  /** 对应 jetlinks AggregationQueryParam.max() */
  max(property: string, alias?: string): this {
    return this.agg(property, AggregationType.MAX, alias);
  }

  /** 对应 jetlinks AggregationQueryParam.min() */
  min(property: string, alias?: string): this {
    return this.agg(property, AggregationType.MIN, alias);
  }

  /** 按标签分组 — 对应 jetlinks AggregationQueryParam.groupBy(property) */
  groupBy(...properties: string[]): this {
    this.query.groupBy = [...(this.query.groupBy ?? []), ...properties];
    return this;
  }

  /** 按时间间隔分组 — 对应 jetlinks AggregationQueryParam.groupBy(Interval, format) */
  groupByInterval(intervalMs: number): this {
    this.query.interval = intervalMs;
    return this;
  }

  /** 标签过滤 */
  filter(tags: Record<string, string>): this {
    this.query.tags = { ...this.query.tags, ...tags };
    return this;
  }

  limit(n: number): this {
    this.query.limit = n;
    return this;
  }

  /** 构建最终查询对象 */
  build(): AggregationQuery {
    // 如果只有一列且无 field 设置，使用第一列作为主字段
    if (!this.query.field && this.query.columns!.length > 0) {
      this.query.field = this.query.columns![0].property;
      this.query.aggregation = this.query.columns![0].aggregation;
    }
    return { ...this.query };
  }

  /** 构建并立即执行 — 对应 jetlinks AggregationQueryParam.execute() */
  execute(service: TimeSeriesService): Promise<AggregationResult[]> {
    return service.aggregate(this.build());
  }
}
