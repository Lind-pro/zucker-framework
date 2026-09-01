/**
 * 事件持久化存储接口。
 * 对标 hsweb EventStore — 支持事件溯源和重放。
 *
 * 默认无实现（事件只在内存中传播）。
 * 生产环境可注入数据库实现以支持事件审计和重放。
 */
export interface EventStore {
  /** 持久化一个事件 */
  save(event: StoredEvent): Promise<void>;
  /** 按主题查询事件 */
  findByTopic(topic: string, options?: EventQueryOptions): Promise<StoredEvent[]>;
  /** 按聚合根查询事件 */
  findByAggregateId(aggregateId: string, options?: EventQueryOptions): Promise<StoredEvent[]>;
  /** 重放事件（按时间顺序） */
  replay(topic: string, fromTimestamp?: number): AsyncIterable<StoredEvent>;
  /** 统计事件数 */
  count(topic?: string): Promise<number>;
}

export interface StoredEvent {
  id?: string;
  topic: string;
  aggregateId?: string;
  aggregateType?: string;
  payload: unknown;
  metadata?: Record<string, unknown>;
  timestamp: number;
  version?: number;
}

export interface EventQueryOptions {
  fromTimestamp?: number;
  toTimestamp?: number;
  limit?: number;
  offset?: number;
}

export const EVENT_STORE = 'EVENT_STORE';
