/**
 * QueryAnalyzer — 查询分析优化
 */
import { type DynamicQueryParam } from '../dynamic-query.service';

export interface OptimizedQuery {
  /** 优化后的查询参数 */
  query: DynamicQueryParam;
  /** 用于 count 的查询（去掉 orderBy 和 select） */
  countQuery: DynamicQueryParam;
  /** 检测到的潜在问题 */
  warnings: string[];
}

export class QueryAnalyzer {
  /**
   * 分析查询参数并返回优化后的查询
   */
  static analyze(queryParam: DynamicQueryParam): OptimizedQuery {
    const warnings: string[] = [];

    // 深拷贝原始查询
    const optimized: DynamicQueryParam = { ...queryParam };

    // 1. 去重重复条件
    if (optimized.filter) {
      const seen = new Set<string>();
      const deduped: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(optimized.filter)) {
        const normalizedKey = key.trim();
        if (seen.has(normalizedKey)) {
          warnings.push(`Duplicate filter condition: "${normalizedKey}"`);
          continue;
        }
        seen.add(normalizedKey);
        deduped[normalizedKey] = value;
      }
      optimized.filter = deduped;
    }

    // 2. 合并排序参数（去重）
    if (optimized.orderBy) {
      const orderParts = optimized.orderBy.split(',').map((s) => s.trim()).filter(Boolean);
      const seenFields = new Set<string>();
      const uniqueOrders: string[] = [];
      for (const part of orderParts) {
        const field = part.split(' ')[0];
        if (seenFields.has(field)) {
          warnings.push(`Duplicate sort field: "${field}"`);
          continue;
        }
        seenFields.add(field);
        uniqueOrders.push(part);
      }
      optimized.orderBy = uniqueOrders.join(',');
    }

    // 3. 派生 count 查询（去掉 orderBy 和 select）
    const countQuery: DynamicQueryParam = {
      filters: optimized.filters,
      where: optimized.where,
      filter: optimized.filter,
      // count 查询不需要排序、分页、字段选择
    };

    // 4. 检测潜在的 N+1 问题
    if (optimized.includes?.length) {
      const relationFields = optimized.includes.filter(
        (f) => f.includes('.') || f.endsWith('s'),
      );
      if (relationFields.length > 1) {
        warnings.push(
          `Potential N+1: multiple relation fields included: ${relationFields.join(', ')}. Consider using a join or separate queries.`,
        );
      }
    }

    // 5. 无分页且无限制的查询警告
    if (!optimized.page && !optimized.pageSize) {
      warnings.push('Query has no pagination, this may return too many results');
    }

    return {
      query: optimized,
      countQuery,
      warnings,
    };
  }
}
