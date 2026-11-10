import { Injectable, Logger } from '@nestjs/common';
import { TimeSeriesMetadata } from './timeseries-metadata';
import { TimeSeriesManager } from './timeseries-manager';
import {
  TimeSeriesService,
  TimeSeriesData,
  TimeSeriesQuery,
  AggregationQuery,
  AggregationResult,
  AggregationType,
  type PagerResult,
} from './timeseries-service';

/**
 * 内存时序数据服务 — 默认实现，适用于开发和测试
 */
class MemoryTimeSeriesService implements TimeSeriesService {
  private data: TimeSeriesData[] = [];

  async save(data: TimeSeriesData): Promise<void> {
    this.data.push({ ...data });
  }

  async saveBatch(data: TimeSeriesData[]): Promise<void> {
    if (!data || data.length === 0) return;
    for (const d of data) {
      this.data.push({ ...d });
    }
  }

  /**
   * commit — 对应 jetlinks TimeSeriesService.commit()
   * 内存实现直接退化为即时 save。
   */
  async commit(data: TimeSeriesData | TimeSeriesData[]): Promise<void> {
    if (Array.isArray(data)) {
      await this.saveBatch(data);
    } else {
      await this.save(data);
    }
  }

  async query(query: TimeSeriesQuery): Promise<TimeSeriesData[]> {
    let results = this.filterData(query);

    results.sort((a, b) =>
      query.order === 'desc'
        ? b.timestamp - a.timestamp
        : a.timestamp - b.timestamp,
    );

    if (query.limit) {
      results = results.slice(0, query.limit);
    }

    return results;
  }

  async multiQuery(queries: TimeSeriesQuery[]): Promise<TimeSeriesData[]> {
    const allResults: TimeSeriesData[] = [];
    for (const q of queries) {
      const results = await this.query(q);
      appendAll(allResults, results);
    }
    return allResults.sort((a, b) => a.timestamp - b.timestamp);
  }

  async count(query: TimeSeriesQuery): Promise<number> {
    return this.filterData(query).length;
  }

  /**
   * queryPager — 对应 jetlinks TimeSeriesService.queryPager()
   *
   * 返回 count + 当前页数据的复合结构，与 Java PagerResult 一致。
   */
  async queryPager(
    query: TimeSeriesQuery,
    pageIndex = 0,
    pageSize = 25,
  ): Promise<PagerResult<TimeSeriesData>> {
    const total = await this.count(query);
    const allData = await this.query({
      ...query,
      limit: undefined,
    });
    const start = pageIndex * pageSize;
    const data = allData.slice(start, start + pageSize);
    return { total, data, pageIndex, pageSize };
  }

  async aggregate(query: AggregationQuery): Promise<AggregationResult[]> {
    const filtered = this.filterData(query);

    // 多列聚合
    if (query.columns?.length) {
      return this.aggregateMultiColumn(filtered, query);
    }

    if (query.interval) {
      return this.aggregateByInterval(filtered, query);
    }

    if (query.groupBy?.length) {
      return this.aggregateByGroup(filtered, query);
    }

    const value = this.computeAggregation(filtered, query.field, query.aggregation);
    return [{ value }];
  }

  async deleteByRange(from: number, to: number, tags?: Record<string, string>): Promise<number> {
    const before = this.data.length;
    this.data = this.data.filter(d => {
      if (d.timestamp >= from && d.timestamp <= to && this.matchTags(d.tags, tags)) {
        return false; // remove
      }
      return true; // keep
    });
    return before - this.data.length;
  }

  /** 获取当前存储的数据量（内部使用） */
  get size(): number {
    return this.data.length;
  }

  private filterData(query: TimeSeriesQuery): TimeSeriesData[] {
    return this.data.filter(d =>
      d.timestamp >= query.from &&
      d.timestamp <= query.to &&
      this.matchTags(d.tags, query.tags),
    );
  }

  private aggregateMultiColumn(
    data: TimeSeriesData[],
    query: AggregationQuery,
  ): AggregationResult[] {
    const columns = query.columns!;

    // 如果有 interval 或 groupBy，需要先分组
    if (query.interval || query.groupBy?.length) {
      const buckets = this.buildBuckets(data, query);
      const results: AggregationResult[] = [];

      for (const { timestamp, tags, items } of buckets.values()) {
        const result: AggregationResult = {
          value: 0,
          values: {},
        };

        if (timestamp !== undefined) result.timestamp = timestamp;
        if (tags) result.tags = tags;

        for (const col of columns) {
          const alias = col.alias ?? col.property;
          const val = this.computeAggregation(items, col.property, col.aggregation);
          result.values![alias] = val === 0 && col.defaultValue !== undefined
            ? col.defaultValue
            : val;
        }

        // 第一列的值作为主 value（向后兼容）
        if (columns.length > 0) {
          const firstAlias = columns[0].alias ?? columns[0].property;
          result.value = result.values![firstAlias];
        }

        results.push(result);
      }

      return results;
    }

    // 无分组：单条结果
    const values: Record<string, number> = {};
    for (const col of columns) {
      const alias = col.alias ?? col.property;
      const val = this.computeAggregation(data, col.property, col.aggregation);
      values[alias] = val === 0 && col.defaultValue !== undefined
        ? col.defaultValue
        : val;
    }

    const firstAlias = columns.length > 0 ? (columns[0].alias ?? columns[0].property) : '';
    return [{
      value: firstAlias ? values[firstAlias] : 0,
      values,
    }];
  }

  /**
   * 按时间桶 / 分组标签分桶。桶键用 JSON 编码的元组，标签值中包含 `|`、`=`、`,`
   * 时也不会相互冲突；时间戳与标签直接保存在桶中，不再从字符串键反解析。
   */
  private buildBuckets(
    data: TimeSeriesData[],
    query: AggregationQuery,
  ): Map<string, { timestamp?: number; tags?: Record<string, string>; items: TimeSeriesData[] }> {
    const buckets = new Map<string, { timestamp?: number; tags?: Record<string, string>; items: TimeSeriesData[] }>();

    for (const d of data) {
      const timestamp = query.interval
        ? Math.floor(d.timestamp / query.interval) * query.interval
        : undefined;
      let tags: Record<string, string> | undefined;
      if (query.groupBy?.length) {
        tags = {};
        for (const tag of query.groupBy) tags[tag] = d.tags[tag] ?? '';
      }

      const key = JSON.stringify([timestamp ?? null, query.groupBy?.map((tag) => d.tags[tag] ?? '') ?? []]);
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { timestamp, tags, items: [] };
        buckets.set(key, bucket);
      }
      bucket.items.push(d);
    }

    return buckets;
  }

  private aggregateByInterval(
    data: TimeSeriesData[],
    query: AggregationQuery,
  ): AggregationResult[] {
    const buckets = new Map<number, TimeSeriesData[]>();

    for (const d of data) {
      const bucketStart = Math.floor(d.timestamp / query.interval!) * query.interval!;
      const bucket = buckets.get(bucketStart) ?? [];
      bucket.push(d);
      buckets.set(bucketStart, bucket);
    }

    const results: AggregationResult[] = [];
    for (const [timestamp, items] of buckets) {
      results.push({
        timestamp,
        value: this.computeAggregation(items, query.field, query.aggregation),
      });
    }

    return results.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  }

  private aggregateByGroup(
    data: TimeSeriesData[],
    query: AggregationQuery,
  ): AggregationResult[] {
    const groups = new Map<string, { tags: Record<string, string>; items: TimeSeriesData[] }>();

    for (const d of data) {
      const values = query.groupBy!.map(tag => d.tags[tag] ?? '');
      const groupKey = JSON.stringify(values);
      let group = groups.get(groupKey);
      if (!group) {
        const tags: Record<string, string> = {};
        query.groupBy!.forEach((tag, i) => { tags[tag] = values[i]; });
        group = { tags, items: [] };
        groups.set(groupKey, group);
      }
      group.items.push(d);
    }

    const results: AggregationResult[] = [];
    for (const { tags, items } of groups.values()) {
      results.push({
        tags,
        value: this.computeAggregation(items, query.field, query.aggregation),
      });
    }

    return results;
  }

  private computeAggregation(
    data: TimeSeriesData[],
    field: string,
    aggregation: AggregationType,
  ): number {
    if (aggregation === AggregationType.COUNT) {
      return data.filter(d => d.values[field] !== undefined).length;
    }

    if (aggregation === AggregationType.DISTINCT_COUNT) {
      const seen = new Set(data.map(d => d.values[field]).filter(v => v !== undefined));
      return seen.size;
    }

    if (aggregation === AggregationType.FIRST || aggregation === AggregationType.TOP) {
      const first = data[0];
      if (!first) return 0;
      const v = first.values[field];
      return typeof v === 'number' ? v : 0;
    }

    if (aggregation === AggregationType.NONE) {
      return 0;
    }

    const values = data
      .map(d => d.values[field])
      .filter((v): v is number => typeof v === 'number');

    if (values.length === 0) return 0;

    switch (aggregation) {
      case AggregationType.SUM:
        return values.reduce((a, b) => a + b, 0);
      case AggregationType.AVG:
        return values.reduce((a, b) => a + b, 0) / values.length;
      case AggregationType.MIN:
        // 不用 Math.min(...values)：大数组展开会超出参数上限并抛 RangeError
        return values.reduce((a, b) => (b < a ? b : a), values[0]);
      case AggregationType.MAX:
        return values.reduce((a, b) => (b > a ? b : a), values[0]);
      default:
        return 0;
    }
  }

  private matchTags(
    dataTags: Record<string, string>,
    queryTags?: Record<string, string>,
  ): boolean {
    if (!queryTags) return true;
    for (const [key, value] of Object.entries(queryTags)) {
      if (dataTags[key] !== value) return false;
    }
    return true;
  }
}

/**
 * 内存时序数据管理器 — 默认实现
 */
@Injectable()
export class MemoryTimeSeriesManager implements TimeSeriesManager {
  private readonly logger = new Logger(MemoryTimeSeriesManager.name);
  private readonly metadataMap = new Map<string, TimeSeriesMetadata>();
  private readonly serviceMap = new Map<string, MemoryTimeSeriesService>();

  registerMetric(metadata: TimeSeriesMetadata): void {
    this.metadataMap.set(metadata.metric, metadata);
    if (!this.serviceMap.has(metadata.metric)) {
      this.serviceMap.set(metadata.metric, new MemoryTimeSeriesService());
    }
    this.logger.log(`Metric registered: ${metadata.metric}`);
  }

  unregisterMetric(metric: string): boolean {
    const existed = this.metadataMap.has(metric);
    this.metadataMap.delete(metric);
    this.serviceMap.delete(metric);
    if (existed) {
      this.logger.log(`Metric unregistered: ${metric}`);
    }
    return existed;
  }

  getMetadata(metric: string): TimeSeriesMetadata | undefined {
    return this.metadataMap.get(metric);
  }

  getAllMetrics(): TimeSeriesMetadata[] {
    return Array.from(this.metadataMap.values());
  }

  getService(metric: string): TimeSeriesService {
    const service = this.serviceMap.get(metric);
    if (!service) {
      throw new Error(`Metric not registered: ${metric}`);
    }
    return service;
  }

  /**
   * 获取多个指标的合并数据服务 — 返回一个代理服务，查询时合并多个指标的结果
   */
  getServices(metrics: string[]): TimeSeriesService {
    if (!metrics || metrics.length === 0) {
      throw new Error('At least one metric must be provided');
    }

    const services = metrics.map(m => {
      const s = this.serviceMap.get(m);
      if (!s) throw new Error(`Metric not registered: ${m}`);
      return s;
    });

    const primaryService = services[0];
    const combinedService: TimeSeriesService = {
      save: async (data) => { await primaryService.save(data); },
      saveBatch: async (data) => { await primaryService.saveBatch(data); },
      query: async (query) => {
        const allResults: TimeSeriesData[] = [];
        for (const s of services) {
          appendAll(allResults, await s.query(query));
        }
        allResults.sort((a, b) =>
          query.order === 'desc' ? b.timestamp - a.timestamp : a.timestamp - b.timestamp,
        );
        return query.limit ? allResults.slice(0, query.limit) : allResults;
      },
      count: async (query) => {
        let total = 0;
        for (const s of services) {
          total += await s.count(query);
        }
        return total;
      },
      aggregate: async (query) => {
        const allResults: AggregationResult[] = [];
        for (const s of services) {
          appendAll(allResults, await s.aggregate(query));
        }
        return allResults;
      },
    };
    return combinedService;
  }
}

/** 逐个追加，避免 `push(...items)` 在大数组上超出参数上限 */
function appendAll<T>(target: T[], items: readonly T[]): void {
  for (const item of items) target.push(item);
}
