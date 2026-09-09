/**
 * 属性事件日志存储 — 对应 jetlinks ThingsDataService / ThingEventLog
 *
 * 负责将上行的属性上报、事件消息持久化到时序数据库，
 * 并提供查询接口。
 */
import { Injectable } from '@nestjs/common';
import type { ReportPropertyMessage, EventMessage } from './message';
import type {
  TimeSeriesService,
  TimeSeriesData,
  TimeSeriesQuery,
  AggregationQuery,
  AggregationResult,
} from '@zucker-framework/timeseries';

/**
 * 属性日志记录
 */
export interface PropertyLog {
  /** 属性 ID */
  property: string;
  /** 属性值 */
  value: unknown;
  /** 物 ID */
  thingId: string;
  /** 物类型 ID */
  thingType: string;
  /** 时间戳（毫秒） */
  timestamp: number;
  /** 上报状态 */
  state?: string;
}

/**
 * 事件日志记录
 */
export interface EventLog {
  /** 事件 ID */
  event: string;
  /** 事件数据（JSON 序列化后存储） */
  data: unknown;
  /** 物 ID */
  thingId: string;
  /** 物类型 ID */
  thingType: string;
  /** 时间戳（毫秒） */
  timestamp: number;
}

/**
 * 属性/事件日志查询条件
 */
export interface ThingLogQuery {
  thingId: string;
  thingType: string;
  /** 属性 ID 或 事件 ID */
  id: string;
  from: number;
  to: number;
  limit?: number;
  order?: 'asc' | 'desc';
}

/**
 * 物数据服务接口 — 对应 jetlinks ThingsDataService
 */
export interface ThingsDataService {
  /**
   * 保存属性上报
   * 对应 jetlinks ThingsDataService.save(DeviceMessage)
   */
  saveProperties(message: ReportPropertyMessage): Promise<void>;

  /**
   * 保存事件
   */
  saveEvent(message: EventMessage): Promise<void>;

  /**
   * 查询属性历史
   */
  queryPropertyLogs(query: ThingLogQuery): Promise<PropertyLog[]>;

  /**
   * 查询事件历史
   */
  queryEventLogs(query: ThingLogQuery): Promise<EventLog[]>;

  /**
   * 聚合查询属性数据
   */
  aggregateProperties(
    thingId: string,
    thingType: string,
    property: string,
    aggQuery: Omit<AggregationQuery, 'metric'>,
  ): Promise<AggregationResult[]>;
}

/**
 * 基于 TimeSeriesService 的默认实现
 *
 * 指标命名约定：
 *   属性：`thing_property_{thingType}`
 *   事件：`thing_event_{thingType}_{eventId}`
 */
@Injectable()
export class DefaultThingsDataService implements ThingsDataService {
  constructor(private readonly tsService: TimeSeriesService) {}

  private propertyMetric(thingType: string): string {
    return `thing_property_${thingType}`;
  }

  private eventMetric(thingType: string, eventId: string): string {
    return `thing_event_${thingType}_${eventId}`;
  }

  async saveProperties(message: ReportPropertyMessage): Promise<void> {
    const metric = this.propertyMetric(message.thingType);
    const points: TimeSeriesData[] = Object.entries(message.properties).map(
      ([key, value]) => ({
        timestamp: message.propertySourceTimes?.[key] ?? message.timestamp,
        tags: { thingId: message.thingId, thingType: message.thingType, property: key },
        values: {
          value: typeof value === 'object' ? JSON.stringify(value) : (value as string | number | boolean),
          state: message.propertyStates?.[key] ?? 'success',
        },
      }),
    );

    // 每个属性单独以自身的 metric 存储，便于查询
    for (const point of points) {
      const propMetric = `thing_property_${message.thingType}_${point.tags['property']}`;
      await this.tsService.save({ ...point, tags: { thingId: point.tags['thingId'], thingType: point.tags['thingType'] } });
      void propMetric; // 当前统一写 thingType metric，实现可按需拆分
    }

    if (points.length > 0) {
      await this.tsService.saveBatch(
        points.map((p) => ({
          ...p,
          tags: { ...p.tags },
          values: { ...p.values, metric },
        })),
      );
    }
  }

  async saveEvent(message: EventMessage): Promise<void> {
    const metric = this.eventMetric(message.thingType, message.event);
    const data: TimeSeriesData = {
      timestamp: message.timestamp,
      tags: { thingId: message.thingId, thingType: message.thingType, event: message.event },
      values: {
        data: typeof message.data === 'object' ? JSON.stringify(message.data) : (message.data as string | number | boolean),
        metric,
      },
    };
    await this.tsService.save(data);
  }

  async queryPropertyLogs(query: ThingLogQuery): Promise<PropertyLog[]> {
    const tsQuery: TimeSeriesQuery = {
      metric: this.propertyMetric(query.thingType),
      from: query.from,
      to: query.to,
      tags: { thingId: query.thingId, property: query.id },
      limit: query.limit,
      order: query.order,
    };

    const results = await this.tsService.query(tsQuery);
    return results.map((r: TimeSeriesData) => ({
      property: String(r.tags['property'] ?? query.id),
      value: r.values['value'],
      thingId: String(r.tags['thingId']),
      thingType: String(r.tags['thingType'] ?? query.thingType),
      timestamp: r.timestamp,
      state: r.values['state'] as string | undefined,
    }));
  }

  async queryEventLogs(query: ThingLogQuery): Promise<EventLog[]> {
    const tsQuery: TimeSeriesQuery = {
      metric: this.eventMetric(query.thingType, query.id),
      from: query.from,
      to: query.to,
      tags: { thingId: query.thingId },
      limit: query.limit,
      order: query.order,
    };

    const results = await this.tsService.query(tsQuery);
    return results.map((r: TimeSeriesData) => {
      let data: unknown = r.values['data'];
      if (typeof data === 'string') {
        try {
          data = JSON.parse(data);
        } catch {
          // keep as string
        }
      }
      return {
        event: String(r.tags['event'] ?? query.id),
        data,
        thingId: String(r.tags['thingId']),
        thingType: String(r.tags['thingType'] ?? query.thingType),
        timestamp: r.timestamp,
      };
    });
  }

  async aggregateProperties(
    thingId: string,
    thingType: string,
    property: string,
    aggQuery: Omit<AggregationQuery, 'metric'>,
  ): Promise<AggregationResult[]> {
    const query: AggregationQuery = {
      ...aggQuery,
      metric: this.propertyMetric(thingType),
      tags: { ...aggQuery.tags, thingId, property },
    };
    return this.tsService.aggregate(query);
  }
}
