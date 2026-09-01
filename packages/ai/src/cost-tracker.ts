import { Injectable, Logger } from '@nestjs/common';

/**
 * AI 调用成本追踪。
 * 记录每次 AI 调用的 token 消耗和成本。
 */
export interface CostRecord {
  timestamp: number;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: number;
  userId?: string;
  scenario?: string;
  duration: number;
}

@Injectable()
export class CostTracker {
  private readonly logger = new Logger(CostTracker.name);
  private readonly records: CostRecord[] = [];
  private static readonly MAX_RECORDS = 10000;

  /** 记录一次 AI 调用成本 */
  record(entry: CostRecord): void {
    if (this.records.length >= CostTracker.MAX_RECORDS) {
      this.records.shift();
    }
    this.records.push(entry);
  }

  /** 获取总成本 */
  getTotalCost(filter?: { provider?: string; userId?: string; since?: number }): number {
    return this.getFilteredRecords(filter).reduce((sum, r) => sum + r.cost, 0);
  }

  /** 获取总 token 消耗 */
  getTotalTokens(filter?: { provider?: string; userId?: string; since?: number }): number {
    return this.getFilteredRecords(filter).reduce((sum, r) => sum + r.totalTokens, 0);
  }

  /** 获取调用次数 */
  getCallCount(filter?: { provider?: string; userId?: string; since?: number }): number {
    return this.getFilteredRecords(filter).length;
  }

  /** 按 provider 分组统计 */
  getStatsByProvider(since?: number): Map<string, { calls: number; tokens: number; cost: number }> {
    const stats = new Map<string, { calls: number; tokens: number; cost: number }>();
    const filtered = since ? this.records.filter(r => r.timestamp >= since) : this.records;

    for (const r of filtered) {
      const existing = stats.get(r.provider) ?? { calls: 0, tokens: 0, cost: 0 };
      existing.calls++;
      existing.tokens += r.totalTokens;
      existing.cost += r.cost;
      stats.set(r.provider, existing);
    }

    return stats;
  }

  /** 按用户分组统计 */
  getStatsByUser(since?: number): Map<string, { calls: number; tokens: number; cost: number }> {
    const stats = new Map<string, { calls: number; tokens: number; cost: number }>();
    const filtered = since ? this.records.filter(r => r.timestamp >= since) : this.records;

    for (const r of filtered) {
      const userId = r.userId ?? 'anonymous';
      const existing = stats.get(userId) ?? { calls: 0, tokens: 0, cost: 0 };
      existing.calls++;
      existing.tokens += r.totalTokens;
      existing.cost += r.cost;
      stats.set(userId, existing);
    }

    return stats;
  }

  /** 获取最近 N 条记录 */
  getRecentRecords(limit = 20): CostRecord[] {
    return this.records.slice(-limit).reverse();
  }

  /** 清空记录 */
  clear(): void {
    this.records.length = 0;
  }

  private getFilteredRecords(filter?: { provider?: string; userId?: string; since?: number }): CostRecord[] {
    if (!filter) return this.records;
    return this.records.filter(r => {
      if (filter.provider && r.provider !== filter.provider) return false;
      if (filter.userId && r.userId !== filter.userId) return false;
      if (filter.since && r.timestamp < filter.since) return false;
      return true;
    });
  }
}
