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
   * 框架在 `PersistedCostTracker.flush()` 时调用。失败应该 throw；框架保留统计并向调用方抛出，由调用方安排重试。
   */
  persist(records: AggregatedCostRecord[], period: AggregationPeriod): Promise<void>;
}

export interface AggregatedCostRecord {
  modelId: string;
  provider?: string;
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
  private aggregated = new Map<string, MutableAggregate>();
  private flushing?: Promise<void>;
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
  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = this.flushSnapshot().finally(() => { this.flushing = undefined; });
    return this.flushing;
  }

  private async flushSnapshot(): Promise<void> {
    if (this.aggregated.size === 0) return;
    const snapshot = this.aggregated;
    this.aggregated = new Map();
    const periodStart = this.periodStart;
    const periodEnd = new Date();
    this.periodStart = periodEnd;
    const records: AggregatedCostRecord[] = [];
    const skipped: string[] = [];

    for (const [key, agg] of snapshot.entries()) {
      if (this.options.skipMissingModelRecordId && !agg.modelRecordId) {
        skipped.push(key);
        continue;
      }
      records.push({
        modelId: agg.modelId,
        provider: agg.provider,
        modelRecordId: agg.modelRecordId,
        scenario: agg.scenario,
        requestCount: agg.requestCount,
        successCount: agg.successCount,
        failureCount: agg.failureCount,
        inputTokens: agg.inputTokens,
        outputTokens: agg.outputTokens,
        totalTokens: agg.totalTokens,
        totalCost: agg.totalCost,
        avgResponseTime: agg.responseTimeCount ? agg.responseTimeSum / agg.responseTimeCount : null,
        minResponseTime: agg.responseTimeCount ? agg.minResponseTime : null,
        maxResponseTime: agg.responseTimeCount ? agg.maxResponseTime : null,
      });
    }

    skipped.forEach((k) => snapshot.delete(k));
    if (skipped.length > 0) this._logger.warn(`跳过 ${skipped.length} 条 AI 模型统计记录：缺少 modelRecordId`);
    if (records.length === 0) return;

    try {
      await this.persister.persist(records, { start: periodStart, end: periodEnd });
      this._logger.log(
        `已刷新 ${records.length} 条 AI 使用统计 (会话总: $${this.sessionTotalCost.toFixed(4)})`,
      );
    } catch (e) {
      // Restore only the failed snapshot; calls arriving during persistence must not be lost.
      for (const [key, previous] of snapshot) {
        const current = this.aggregated.get(key);
        if (current) {
          previous.requestCount += current.requestCount;
          previous.successCount += current.successCount;
          previous.failureCount += current.failureCount;
          previous.inputTokens += current.inputTokens;
          previous.outputTokens += current.outputTokens;
          previous.totalTokens += current.totalTokens;
          previous.totalCost += current.totalCost;
          previous.responseTimeSum += current.responseTimeSum;
          previous.responseTimeCount += current.responseTimeCount;
          previous.minResponseTime = Math.min(previous.minResponseTime, current.minResponseTime);
          previous.maxResponseTime = Math.max(previous.maxResponseTime, current.maxResponseTime);
        }
        this.aggregated.set(key, previous);
      }
      this.periodStart = periodStart;
      this._logger.error('刷新 AI 模型使用统计失败；保留统计等待重试');
      throw e;
    }
  }

  /** 测试或运维手动触发 */
  async manualFlush(): Promise<void> {
    return this.flush();
  }

  private aggregate(entry: CostRecord & { modelRecordId?: string; success?: boolean }): void {
    const key = JSON.stringify([entry.provider, entry.model, entry.scenario ?? null, entry.modelRecordId ?? null]);
    let agg = this.aggregated.get(key);
    if (!agg) {
      agg = {
        modelId: entry.model,
        provider: entry.provider,
        modelRecordId: entry.modelRecordId,
        scenario: entry.scenario,
        requestCount: 0,
        successCount: 0,
        failureCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        totalCost: 0,
        responseTimeSum: 0,
        responseTimeCount: 0,
        minResponseTime: Number.POSITIVE_INFINITY,
        maxResponseTime: Number.NEGATIVE_INFINITY,
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
    // Running statistics: sample arrays grew without bound across failed flushes and
    // Math.min(...samples) throws RangeError once they are large.
    if (entry.duration !== undefined && Number.isFinite(entry.duration)) {
      agg.responseTimeSum += entry.duration;
      agg.responseTimeCount += 1;
      agg.minResponseTime = Math.min(agg.minResponseTime, entry.duration);
      agg.maxResponseTime = Math.max(agg.maxResponseTime, entry.duration);
    }
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
  provider?: string;
  modelRecordId?: string;
  scenario?: string;
  requestCount: number;
  successCount: number;
  failureCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  totalCost: number;
  responseTimeSum: number;
  responseTimeCount: number;
  minResponseTime: number;
  maxResponseTime: number;
}
