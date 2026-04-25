/**
 * In-memory DatabaseAdapter for e2e tests.
 *
 * Stores all records in Maps keyed by model name.
 * Supports the full ModelOperations contract used by @zucker/* services.
 */
import type { DatabaseAdapter, ModelOperations } from '@zucker/core';

type Row = Record<string, unknown>;

/** Match a single row against a Prisma-style where clause (shallow equality). */
function matchesWhere(row: Row, where: Record<string, unknown> = {}): boolean {
  for (const [key, val] of Object.entries(where)) {
    if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
      // Prisma nested operator: { equals, contains, in, not, ... }
      const ops = val as Record<string, unknown>;
      if ('equals' in ops && row[key] !== ops['equals']) return false;
      if ('in' in ops && !((ops['in'] as unknown[]).includes(row[key]))) return false;
      if ('not' in ops && row[key] === ops['not']) return false;
      if ('contains' in ops && typeof row[key] === 'string' &&
          !(row[key] as string).includes(ops['contains'] as string)) return false;
    } else {
      if (row[key] !== val) return false;
    }
  }
  return true;
}

function applyOrderBy(rows: Row[], orderBy?: Record<string, 'asc' | 'desc'>[]): Row[] {
  if (!orderBy?.length) return rows;
  return [...rows].sort((a, b) => {
    for (const spec of orderBy) {
      for (const [field, dir] of Object.entries(spec)) {
        const av = a[field] as string | number;
        const bv = b[field] as string | number;
        if (av < bv) return dir === 'asc' ? -1 : 1;
        if (av > bv) return dir === 'asc' ? 1 : -1;
      }
    }
    return 0;
  });
}

class InMemoryModelOperations implements ModelOperations {
  constructor(private readonly store: Row[]) {}

  async findUnique({ where }: { where: Row }): Promise<Row | null> {
    return this.store.find((r) => matchesWhere(r, where)) ?? null;
  }

  async findFirst(args: { where?: Row } = {}): Promise<Row | null> {
    return this.store.find((r) => matchesWhere(r, args.where)) ?? null;
  }

  async findMany(args: { where?: Row; orderBy?: Record<string, 'asc' | 'desc'>[]; skip?: number; take?: number } = {}): Promise<Row[]> {
    let result = this.store.filter((r) => matchesWhere(r, args.where));
    result = applyOrderBy(result, args.orderBy);
    if (args.skip) result = result.slice(args.skip);
    if (args.take !== undefined) result = result.slice(0, args.take);
    return result;
  }

  async create({ data }: { data: Row }): Promise<Row> {
    const row = { ...data };
    this.store.push(row);
    return row;
  }

  async update({ where, data }: { where: Row; data: Row }): Promise<Row> {
    const idx = this.store.findIndex((r) => matchesWhere(r, where));
    if (idx === -1) throw new Error(`Record not found for update: ${JSON.stringify(where)}`);
    this.store[idx] = { ...this.store[idx], ...data };
    return this.store[idx];
  }

  async delete({ where }: { where: Row }): Promise<Row> {
    const idx = this.store.findIndex((r) => matchesWhere(r, where));
    if (idx === -1) throw new Error(`Record not found for delete: ${JSON.stringify(where)}`);
    const [removed] = this.store.splice(idx, 1);
    return removed;
  }

  async count(args: { where?: Row } = {}): Promise<number> {
    return this.store.filter((r) => matchesWhere(r, args.where)).length;
  }

  async createMany({ data }: { data: Row[] }): Promise<{ count: number }> {
    this.store.push(...data.map((d) => ({ ...d })));
    return { count: data.length };
  }

  async updateMany({ where, data }: { where?: Row; data: Row }): Promise<{ count: number }> {
    let count = 0;
    for (let i = 0; i < this.store.length; i++) {
      if (matchesWhere(this.store[i], where)) {
        this.store[i] = { ...this.store[i], ...data };
        count++;
      }
    }
    return { count };
  }

  async deleteMany(args: { where?: Row } = {}): Promise<{ count: number }> {
    const before = this.store.length;
    const keep = this.store.filter((r) => !matchesWhere(r, args.where));
    this.store.length = 0;
    this.store.push(...keep);
    return { count: before - this.store.length };
  }
}

export class InMemoryDatabaseAdapter implements DatabaseAdapter {
  private readonly tables = new Map<string, Row[]>();

  /** Seed initial data for a model (useful for test setup). */
  seed(modelName: string, rows: Row[]): void {
    if (!this.tables.has(modelName)) this.tables.set(modelName, []);
    this.tables.get(modelName)!.push(...rows.map((r) => ({ ...r })));
  }

  model(name: string): ModelOperations {
    if (!this.tables.has(name)) this.tables.set(name, []);
    return new InMemoryModelOperations(this.tables.get(name)!);
  }

  async $transaction<T>(fn: (adapter: DatabaseAdapter) => Promise<T>): Promise<T> {
    return fn(this);
  }
}
