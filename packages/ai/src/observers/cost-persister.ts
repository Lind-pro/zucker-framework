import { Injectable, Logger } from '@nestjs/common';
import { CostTracker, type CostRecord } from '../cost-tracker';

/**
 * Persist 聚合后的 AI 用量统计到外部存储（DB / 监控系统）的接口。
 *
 * 业务侧实现一个 `CostPersister`（写入 ai_model_usage / metrics push 等），
 * 框架的 PersistedCostTracker 负责聚合 + 周期 flush。
 *
 * 框架不绑定具体 schema：把字段映射 / 表名 / Prisma 调用都留给业务实现，
 * 只描述「框架要把这些字段往外送」。
 */
export interface CostPersister {
  /**
   * 把当前聚合周期的统计写入外部存储。
   * 框架在 `PersistedCostTracker.flush()` 时调用。失败应该 throw（框架会 log 但不停 flush）。
   */
  persist(records: AggregatedCostRecord[], period: AggregationPeriod): Promise<void>;
}

export interface AggregatedCostRecord {
  modelId: string;
  /** 业务侧的 ai_model 表主键（来自 metadata.modelRecordId）*/
  modelRecordId?: string;
  scenario?: string;
  requestCount: number;
  successCount: number;
  failureCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  totalCost: number;
  /** 平均响应时间 ms；无样本时 null */
  avgResponseTime: number | null;
  minResponseTime: number | null;
  maxResponseTime: number | null;
}

export interface AggregationPeriod {
  start: Date;
  end: Date;
}

export interface PersistedCostTrackerOptions {
  /** 单次调用 cost 告警阈值（USD），超出 log warn */
  perCallWarnThresholdUsd?: number;
  /** 整个进程会话累计 cost 告警阈值（USD），首次超出 log warn 一次 */
  sessionWarnThresholdUsd?: number;
  /** 没有 modelRecordId 的聚合是否跳过 persist（避免外键失败）。默认 true */
  skipMissingModelRecordId?: boolean;
}

/**
 * 扩展 framework CostTracker，加入：
 * - 按 model:scenario:modelRecordId 聚合
 * - flush() 时把聚合送给业务提供的 CostPersister
 * - 阈值告警
 *
 * 注意：**框架不在这里加 @Cron**——业务侧用 @nestjs/schedule 的 @Cron
 * 装饰器自己驱动 flush() 的周期。这样框架不强依赖 schedule 模块。
 *
 * @example
 * ```ts
 * @Injectable()
 * export class MyCostTracker extends PersistedCostTracker {
 *   constructor(persister: MyDbPersister) {
 *     super(persister, { perCallWarnThresholdUsd: 0.1 });
 *   }
 *
 *   @Cron('* /5 * * * *')
 *   override async flush() { return super.flush(); }
 * }
 * ```
 */
@Injectable()
export class PersistedCostTracker extends CostTracker {
  private readonly _logger = new Logger(PersistedCostTracker.name);
  private readonly aggregated = new Map<string, MutableAggregate>();
  private periodStart = new Date();
  private sessionWarned = false;
  private sessionTotalCost = 0;
  private readonly options: Required<PersistedCostTrackerOptions>;

  constructor(
    protected readonly persister: CostPersister,
    options: PersistedCostTrackerOptions = {},
  ) {
    super();
    this.options = {
      perCallWarnThresholdUsd: options.perCallWarnThresholdUsd ?? 0.1,
      sessionWarnThresholdUsd: options.sessionWarnThresholdUsd ?? 5.0,
      skipMissingModelRecordId: options.skipMissingModelRecordId ?? true,
    };
  }

  /** 重写 record：在框架内存记录之上做聚合 + 告警 */
  override record(entry: CostRecord & { modelRecordId?: string; success?: boolean }): void {
    super.record(entry);
    this.aggregate(entry);
    this.checkWarnings(entry);
  }

  /** 把当前聚合周期 flush 到外部存储。业务侧通常用 @Cron 驱动 */
  async flush(): Promise<void> {
    if (this.aggregated.size === 0) return;
    const periodEnd = new Date();
    const records: AggregatedCostRecord[] = [];
    const skipped: string[] = [];

    for (const [key, agg] of this.aggregated.entries()) {
      if (this.options.skipMissingModelRecordId && !agg.modelRecordId) {
        skipped.push(key);
        continue;
      }
      records.push({
        modelId: agg.modelId,
        modelRecordId: agg.modelRecordId,
        scenario: agg.scenario,
        requestCount: agg.requestCount,
        successCount: agg.successCount,
        failureCount: agg.failureCount,
        inputTokens: agg.inputTokens,
        outputTokens: agg.outputTokens,
        totalTokens: agg.totalTokens,
        totalCost: agg.totalCost,
        avgResponseTime: agg.responseTimes.length
          ? agg.responseTimes.reduce((a, b) => a + b, 0) / agg.responseTimes.length
          : null,
        minResponseTime: agg.responseTimes.length ? Math.min(...agg.responseTimes) : null,
        maxResponseTime: agg.responseTimes.length ? Math.max(...agg.responseTimes) : null,
      });
    }

    skipped.forEach((k) => this.aggregated.delete(k));

    if (records.length === 0) {
      if (skipped.length > 0) {
        this._logger.warn(
          `跳过 ${skipped.length} 条 AI 模型统计记录：缺少 modelRecordId`,
        );
      }
      this.periodStart = periodEnd;
      return;
    }

    try {
      await this.persister.persist(records, { start: this.periodStart, end: periodEnd });
      this._logger.log(
        `已刷新 ${records.length} 条 AI 使用统计 (会话总: $${this.sessionTotalCost.toFixed(4)})`,
      );
      this.aggregated.clear();
      this.periodStart = periodEnd;
    } catch (e) {
      this._logger.error('刷新 AI 模型使用统计失败:', e);
    }
  }

  /** 测试或运维手动触发 */
  async manualFlush(): Promise<void> {
    return this.flush();
  }

  private aggregate(entry: CostRecord & { modelRecordId?: string; success?: boolean }): void {
    const key = aggKey(entry.model, entry.scenario, entry.modelRecordId);
    let agg = this.aggregated.get(key);
    if (!agg) {
      agg = {
        modelId: entry.model,
        modelRecordId: entry.modelRecordId,
        scenario: entry.scenario,
        requestCount: 0,
        successCount: 0,
        failureCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        totalCost: 0,
        responseTimes: [],
      };
      this.aggregated.set(key, agg);
    }
    agg.requestCount += 1;
    if (entry.success !== false) agg.successCount += 1;
    else agg.failureCount += 1;
    agg.inputTokens += entry.inputTokens;
    agg.outputTokens += entry.outputTokens;
    agg.totalTokens += entry.totalTokens;
    agg.totalCost += entry.cost;
    if (entry.duration !== undefined) agg.responseTimes.push(entry.duration);
  }

  private checkWarnings(entry: CostRecord): void {
    if (entry.cost > this.options.perCallWarnThresholdUsd) {
      this._logger.warn(
        `⚠️ 单次 AI 调用成本较高: $${entry.cost.toFixed(4)} (阈值: $${this.options.perCallWarnThresholdUsd})`,
      );
    }
    this.sessionTotalCost += entry.cost;
    if (!this.sessionWarned && this.sessionTotalCost > this.options.sessionWarnThresholdUsd) {
      this.sessionWarned = true;
      this._logger.warn(
        `⚠️ 会话总成本超过阈值: $${this.sessionTotalCost.toFixed(2)}`,
      );
    }
  }
}

interface MutableAggregate {
  modelId: string;
  modelRecordId?: string;
  scenario?: string;
  requestCount: number;
  successCount: number;
  failureCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  totalCost: number;
  responseTimes: number[];
}

function aggKey(modelId: string, scenario?: string, modelRecordId?: string): string {
  return `${modelRecordId ?? modelId}:${scenario ?? 'default'}`;
}
