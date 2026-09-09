import { randomUUID } from 'crypto';
import {
  TransactionAwareDatabaseAdapter,
  type DatabaseAdapter,
  type ModelOperations,
} from '@zucker-framework/core';

/**
 * InMemoryAdapter — development / testing database adapter.
 *
 * Stores all data in a plain JS Map<model, Map<id, record>>.
 * Supports simple Prisma-style where-clauses (equality only) and
 * auto-generates string IDs when missing.
 *
 * NOT suitable for production — data is lost on restart.
 *
 * Usage:
 * ```typescript
 * ZuckerCrudModule.forRoot({ adapterClass: InMemoryAdapter })
 * ```
 */
export class InMemoryAdapter extends TransactionAwareDatabaseAdapter {
  /** Shared store across all model instances */
  private readonly store = new Map<string, Map<string, Record<string, unknown>>>();

  private getStore(name: string): Map<string, Record<string, unknown>> {
    if (!this.store.has(name)) {
      this.store.set(name, new Map());
    }
    return this.store.get(name)!;
  }

  model(name: string): ModelOperations {
    return new InMemoryModelOperations(this.getStore(name));
  }

  protected override async doTransaction<T>(
    fn: (adapter: DatabaseAdapter) => Promise<T>,
  ): Promise<T> {
    // In-memory transactions run directly (no isolation needed for dev)
    return fn(this);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Evaluate a Prisma-style where clause against a record.
 *
 * Supported operators:
 * - equality (implicit): { field: value }
 * - in / notIn: { field: { in: [...] } }
 * - not: { field: { not: value } }
 * - gt / gte / lt / lte: numeric / date comparisons
 * - contains / startsWith / endsWith: string matching
 * - equals: explicit equality
 * - AND / OR / NOT: logical combinators
 *
 * 对标 Prisma Client 查询 API，确保 InMemoryAdapter 在开发环境下
 * 能正确处理 DynamicQueryService 生成的复杂过滤条件。
 */
function matchesWhere(
  record: Record<string, unknown>,
  where: Record<string, unknown>,
): boolean {
  for (const [key, value] of Object.entries(where)) {
    if (value === undefined) continue;

    // Prisma 复合唯一键展开：如果 key 不存在于 record 中，
    // 但 value 是纯对象（非数组），则将其内部字段当作 AND 条件匹配。
    // 例如：{ scope_key: { scope: 'x', key: 'y' } } → 匹配 record.scope='x' AND record.key='y'
    if (
      !(key in record) &&
      key !== 'AND' && key !== 'OR' && key !== 'NOT' &&
      typeof value === 'object' && value !== null && !Array.isArray(value)
    ) {
      const nested = value as Record<string, unknown>;
      // 检查是否所有嵌套字段都是简单值（非操作符对象）
      const allSimple = Object.values(nested).every(
        v => typeof v !== 'object' || v === null,
      );
      if (allSimple) {
        if (!matchesWhere(record, nested)) return false;
        continue;
      }
    }

    // Logical combinators
    if (key === 'AND') {
      const clauses = Array.isArray(value) ? value : [value];
      if (!clauses.every((c: Record<string, unknown>) => matchesWhere(record, c))) return false;
      continue;
    }
    if (key === 'OR') {
      const clauses = value as Record<string, unknown>[];
      if (!clauses.some((c) => matchesWhere(record, c))) return false;
      continue;
    }
    if (key === 'NOT') {
      const clause = value as Record<string, unknown>;
      if (matchesWhere(record, clause)) return false;
      continue;
    }

    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const ops = value as Record<string, unknown>;
      const rv = record[key];
      const insensitive = ops.mode === 'insensitive';

      for (const [op, ov] of Object.entries(ops)) {
        switch (op) {
          case 'equals':
            if (rv !== ov) return false;
            break;
          case 'not':
            if (rv === ov) return false;
            break;
          case 'in':
            if (!Array.isArray(ov) || !(ov as unknown[]).includes(rv)) return false;
            break;
          case 'notIn':
            if (Array.isArray(ov) && (ov as unknown[]).includes(rv)) return false;
            break;
          case 'gt':
            if (rv === null || rv === undefined || (rv as number) <= (ov as number)) return false;
            break;
          case 'gte':
            if (rv === null || rv === undefined || (rv as number) < (ov as number)) return false;
            break;
          case 'lt':
            if (rv === null || rv === undefined || (rv as number) >= (ov as number)) return false;
            break;
          case 'lte':
            if (rv === null || rv === undefined || (rv as number) > (ov as number)) return false;
            break;
          case 'contains': {
            if (typeof rv !== 'string') return false;
            const s = insensitive ? rv.toLowerCase() : rv;
            const t = insensitive ? (ov as string).toLowerCase() : (ov as string);
            if (!s.includes(t)) return false;
            break;
          }
          case 'startsWith': {
            if (typeof rv !== 'string') return false;
            const s2 = insensitive ? rv.toLowerCase() : rv;
            const t2 = insensitive ? (ov as string).toLowerCase() : (ov as string);
            if (!s2.startsWith(t2)) return false;
            break;
          }
          case 'endsWith': {
            if (typeof rv !== 'string') return false;
            const s3 = insensitive ? rv.toLowerCase() : rv;
            const t3 = insensitive ? (ov as string).toLowerCase() : (ov as string);
            if (!s3.endsWith(t3)) return false;
            break;
          }
          case 'has':
            if (!Array.isArray(rv) || !(rv as unknown[]).includes(ov)) return false;
            break;
          case 'hasEvery':
            if (!Array.isArray(rv) || !Array.isArray(ov)) return false;
            if (!(ov as unknown[]).every(v => (rv as unknown[]).includes(v))) return false;
            break;
          case 'hasSome':
            if (!Array.isArray(rv) || !Array.isArray(ov)) return false;
            if (!(ov as unknown[]).some(v => (rv as unknown[]).includes(v))) return false;
            break;
          case 'isEmpty':
            if (ov === true && Array.isArray(rv) && rv.length > 0) return false;
            if (ov === false && (!Array.isArray(rv) || rv.length === 0)) return false;
            break;
          case 'mode':
            // mode: 'insensitive' — handled by contains/startsWith/endsWith above
            break;
          default:
            // Unknown operator — skip (optimistic)
            break;
        }
      }
    } else if (record[key] !== value) {
      return false;
    }
  }
  return true;
}

/** Apply orderBy to a list of records. */
function applyOrderBy(
  records: Record<string, unknown>[],
  orderBy: unknown,
): Record<string, unknown>[] {
  if (!orderBy) return records;
  const orders = Array.isArray(orderBy) ? orderBy : [orderBy];
  return [...records].sort((a, b) => {
    for (const ord of orders as Record<string, 'asc' | 'desc'>[]) {
      for (const [field, dir] of Object.entries(ord)) {
        const av = a[field];
        const bv = b[field];
        if (av === bv) continue;
        // Numeric comparison when both values are numbers, string otherwise
        const cmp =
          typeof av === 'number' && typeof bv === 'number'
            ? av - bv < 0 ? -1 : 1
            : String(av) < String(bv) ? -1 : 1;
        return dir === 'desc' ? -cmp : cmp;
      }
    }
    return 0;
  });
}

// ---------------------------------------------------------------------------
// ModelOperations implementation
// ---------------------------------------------------------------------------

class InMemoryModelOperations<T = Record<string, unknown>> implements ModelOperations<T> {
  constructor(private readonly table: Map<string, Record<string, unknown>>) {}

  private allRecords(): Record<string, unknown>[] {
    return Array.from(this.table.values());
  }

  async findUnique(args: Record<string, unknown>): Promise<T | null> {
    const where = (args.where ?? {}) as Record<string, unknown>;
    const record = this.allRecords().find(r => matchesWhere(r, where));
    return (record ?? null) as T | null;
  }

  async findFirst(args: Record<string, unknown>): Promise<T | null> {
    return this.findUnique(args);
  }

  async findMany(args?: Record<string, unknown>): Promise<T[]> {
    const where = ((args?.where ?? {}) as Record<string, unknown>);
    let results = this.allRecords().filter(r => matchesWhere(r, where));

    if (args?.orderBy) {
      results = applyOrderBy(results, args.orderBy);
    }

    if (typeof args?.skip === 'number') {
      results = results.slice(args.skip as number);
    }
    if (typeof args?.take === 'number') {
      results = results.slice(0, args.take as number);
    }

    return results as T[];
  }

  async create(args: Record<string, unknown>): Promise<T> {
    const data = (args.data ?? {}) as Record<string, unknown>;
    const id = (data.id as string | undefined) ?? randomUUID();
    const record = { ...data, id };
    this.table.set(id, record);
    return record as T;
  }

  async update(args: Record<string, unknown>): Promise<T> {
    const where = (args.where ?? {}) as Record<string, unknown>;
    const data = (args.data ?? {}) as Record<string, unknown>;
    const record = this.allRecords().find(r => matchesWhere(r, where));
    if (!record) throw new Error(`Record not found: ${JSON.stringify(where)}`);
    const updated = { ...record, ...data };
    this.table.set(updated.id as string, updated);
    return updated as T;
  }

  async delete(args: Record<string, unknown>): Promise<T> {
    const where = (args.where ?? {}) as Record<string, unknown>;
    const record = this.allRecords().find(r => matchesWhere(r, where));
    if (!record) throw new Error(`Record not found: ${JSON.stringify(where)}`);
    this.table.delete(record.id as string);
    return record as T;
  }

  async count(args?: Record<string, unknown>): Promise<number> {
    const where = ((args?.where ?? {}) as Record<string, unknown>);
    return this.allRecords().filter(r => matchesWhere(r, where)).length;
  }

  async createMany(args: Record<string, unknown>): Promise<{ count: number }> {
    const rows = (args.data ?? []) as Record<string, unknown>[];
    const skipDuplicates = (args.skipDuplicates ?? false) as boolean;
    let count = 0;
    for (const row of rows) {
      try {
        const id = (row.id as string | undefined) ?? randomUUID();
        if (skipDuplicates && this.table.has(id)) continue;
        await this.create({ data: row });
        count++;
      } catch {
        if (!skipDuplicates) throw new Error('createMany failed');
      }
    }
    return { count };
  }

  async updateMany(args: Record<string, unknown>): Promise<{ count: number }> {
    const where = (args.where ?? {}) as Record<string, unknown>;
    const data = (args.data ?? {}) as Record<string, unknown>;
    const matching = this.allRecords().filter(r => matchesWhere(r, where));
    for (const record of matching) {
      const updated = { ...record, ...data };
      this.table.set(updated.id as string, updated);
    }
    return { count: matching.length };
  }

  async deleteMany(args?: Record<string, unknown>): Promise<{ count: number }> {
    const where = ((args?.where ?? {}) as Record<string, unknown>);
    const matching = this.allRecords().filter(r => matchesWhere(r, where));
    for (const record of matching) {
      this.table.delete(record.id as string);
    }
    return { count: matching.length };
  }

  async aggregate(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const where = (args.where ?? {}) as Record<string, unknown>;
    const matching = this.allRecords().filter(r => matchesWhere(r, where));

    const result: Record<string, unknown> = {};

    if (args._count) {
      result._count =
        typeof args._count === 'boolean' ? matching.length : { _all: matching.length };
    }

    // _sum aggregation
    if (args._sum) {
      const sumResult: Record<string, number | null> = {};
      const fields = typeof args._sum === 'boolean'
        ? Object.keys(matching[0] ?? {})
        : Object.keys(args._sum as Record<string, boolean>).filter(k => (args._sum as Record<string, boolean>)[k]);
      for (const field of fields) {
        if (matching.length === 0) { sumResult[field] = null; continue; }
        sumResult[field] = matching.reduce((acc, r) => acc + (Number(r[field]) || 0), 0);
      }
      result._sum = sumResult;
    }

    // _avg aggregation
    if (args._avg) {
      const avgResult: Record<string, number | null> = {};
      const fields = typeof args._avg === 'boolean'
        ? Object.keys(matching[0] ?? {})
        : Object.keys(args._avg as Record<string, boolean>).filter(k => (args._avg as Record<string, boolean>)[k]);
      for (const field of fields) {
        if (matching.length === 0) { avgResult[field] = null; continue; }
        const sum = matching.reduce((acc, r) => acc + (Number(r[field]) || 0), 0);
        avgResult[field] = sum / matching.length;
      }
      result._avg = avgResult;
    }

    // _min aggregation
    if (args._min) {
      const minResult: Record<string, number | null> = {};
      const fields = typeof args._min === 'boolean'
        ? Object.keys(matching[0] ?? {})
        : Object.keys(args._min as Record<string, boolean>).filter(k => (args._min as Record<string, boolean>)[k]);
      for (const field of fields) {
        const values = matching.map(r => r[field]).filter(v => v !== null && v !== undefined) as number[];
        minResult[field] = values.length === 0 ? null : Math.min(...values);
      }
      result._min = minResult;
    }

    // _max aggregation
    if (args._max) {
      const maxResult: Record<string, number | null> = {};
      const fields = typeof args._max === 'boolean'
        ? Object.keys(matching[0] ?? {})
        : Object.keys(args._max as Record<string, boolean>).filter(k => (args._max as Record<string, boolean>)[k]);
      for (const field of fields) {
        const values = matching.map(r => r[field]).filter(v => v !== null && v !== undefined) as number[];
        maxResult[field] = values.length === 0 ? null : Math.max(...values);
      }
      result._max = maxResult;
    }

    return result;
  }
}
