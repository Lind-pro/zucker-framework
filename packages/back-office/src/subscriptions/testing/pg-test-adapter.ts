/**
 * TEST-ONLY `DatabaseAdapter` over `pg` for the PostgreSQL contract tests. Model name = table,
 * field = column. It implements exactly the Prisma-style argument subset the subscription host emits
 * (equality, null, in/notIn, not, gt/gte/lt/lte, AND/OR/NOT, increment, select, orderBy, skip/take),
 * so a host query outside that portable subset fails loudly here. Not part of the package build.
 */
import type { DatabaseAdapter, ModelOperations } from '@zucker-framework/core';

export interface PgQueryable {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}
export interface PgPoolLike extends PgQueryable {
  connect(): Promise<PgQueryable & { release(): void }>;
}

const quote = (identifier: string) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) throw new Error(`Unsafe identifier ${identifier}`);
  return `"${identifier}"`;
};
const isPlain = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);
const OPERATORS = new Set(['equals', 'in', 'notIn', 'not', 'gt', 'gte', 'lt', 'lte']);

class Params {
  readonly values: unknown[] = [];
  add(value: unknown): string {
    // JSON columns: objects/arrays are sent as JSON text (pg would turn arrays into array literals).
    this.values.push(value !== null && typeof value === 'object' && !(value instanceof Date) ? JSON.stringify(value) : value);
    return `$${this.values.length}`;
  }
}

function condition(column: string, value: unknown, params: Params): string {
  const col = quote(column);
  if (value === null) return `${col} IS NULL`;
  if (!isPlain(value)) return `${col} = ${params.add(value)}`;
  const keys = Object.keys(value);
  if (!keys.length || keys.some(key => !OPERATORS.has(key))) throw new Error(`Unsupported filter on ${column}: ${JSON.stringify(value)}`);
  return keys.map(key => {
    const operand = value[key];
    switch (key) {
      case 'equals': return condition(column, operand, params);
      case 'in':
      case 'notIn': {
        const list = operand as unknown[];
        if (!list.length) return key === 'in' ? 'FALSE' : 'TRUE';
        return `${col} ${key === 'in' ? '' : 'NOT '}IN (${list.map(item => params.add(item)).join(', ')})`;
      }
      case 'not': return operand === null ? `${col} IS NOT NULL` : `NOT (${condition(column, operand, params)})`;
      case 'gt': return `${col} > ${params.add(operand)}`;
      case 'gte': return `${col} >= ${params.add(operand)}`;
      case 'lt': return `${col} < ${params.add(operand)}`;
      default: return `${col} <= ${params.add(operand)}`;
    }
  }).join(' AND ');
}

function where(filter: unknown, params: Params): string {
  if (filter === undefined) return 'TRUE';
  if (!isPlain(filter)) throw new Error('where must be an object');
  const parts = Object.entries(filter).map(([key, value]) => {
    if (key === 'AND') return `(${(Array.isArray(value) ? value : [value]).map(item => where(item, params)).join(' AND ') || 'TRUE'})`;
    if (key === 'OR') return `(${(value as unknown[]).map(item => where(item, params)).join(' OR ') || 'FALSE'})`;
    if (key === 'NOT') return `NOT (${(Array.isArray(value) ? value : [value]).map(item => where(item, params)).join(' AND ') || 'TRUE'})`;
    return condition(key, value, params);
  });
  return parts.length ? parts.join(' AND ') : 'TRUE';
}

function columns(select: unknown): string {
  if (select === undefined) return '*';
  if (!isPlain(select)) throw new Error('select must be an object');
  return Object.entries(select).filter(([, on]) => on === true).map(([key]) => quote(key)).join(', ');
}
function order(orderBy: unknown): string {
  if (orderBy === undefined) return '';
  const items = Array.isArray(orderBy) ? orderBy : [orderBy];
  const parts = items.flatMap(item => Object.entries(item as Record<string, string>).map(([key, direction]) => {
    if (direction !== 'asc' && direction !== 'desc') throw new Error('orderBy direction');
    return `${quote(key)} ${direction.toUpperCase()}`;
  }));
  return parts.length ? ` ORDER BY ${parts.join(', ')}` : '';
}
function assignments(data: Record<string, unknown>, params: Params): string {
  return Object.entries(data).map(([key, value]) => {
    if (isPlain(value) && 'increment' in value && Object.keys(value).length === 1)
      return `${quote(key)} = ${quote(key)} + ${params.add(value.increment)}`;
    return `${quote(key)} = ${params.add(value)}`;
  }).join(', ');
}
function allowed(args: Record<string, unknown> | undefined, keys: string[]) {
  for (const key of Object.keys(args ?? {})) if (!keys.includes(key)) throw new Error(`Unsupported argument ${key}`);
}

function model(db: PgQueryable, table: string): ModelOperations<Record<string, unknown>> {
  const t = quote(table);
  const many = async (args: Record<string, unknown> = {}) => {
    allowed(args, ['where', 'select', 'orderBy', 'skip', 'take']);
    const params = new Params();
    const sql = `SELECT ${columns(args.select)} FROM ${t} WHERE ${where(args.where, params)}${order(args.orderBy)}`
      + (args.take !== undefined ? ` LIMIT ${Number(args.take)}` : '') + (args.skip !== undefined ? ` OFFSET ${Number(args.skip)}` : '');
    return (await db.query(sql, params.values)).rows;
  };
  return {
    findUnique: async args => (await many({ ...args, take: 1 }))[0] ?? null,
    findFirst: async args => (await many({ ...args, take: 1 }))[0] ?? null,
    findMany: many,
    async create(args) {
      allowed(args, ['data', 'select']);
      const data = args.data as Record<string, unknown>;
      const params = new Params();
      const keys = Object.keys(data);
      const values = keys.map(key => params.add(data[key]));
      const sql = keys.length ? `INSERT INTO ${t} (${keys.map(quote).join(', ')}) VALUES (${values.join(', ')}) RETURNING *`
        : `INSERT INTO ${t} DEFAULT VALUES RETURNING *`;
      return (await db.query(sql, params.values)).rows[0];
    },
    async update(args) {
      allowed(args, ['where', 'data']);
      const params = new Params();
      const set = assignments(args.data as Record<string, unknown>, params);
      const rows = (await db.query(`UPDATE ${t} SET ${set} WHERE ${where(args.where, params)} RETURNING *`, params.values)).rows;
      if (rows.length !== 1) throw Object.assign(new Error('Record to update not found'), { code: 'P2025' });
      return rows[0];
    },
    async delete(args) {
      allowed(args, ['where']);
      const params = new Params();
      const rows = (await db.query(`DELETE FROM ${t} WHERE ${where(args.where, params)} RETURNING *`, params.values)).rows;
      if (rows.length !== 1) throw Object.assign(new Error('Record to delete not found'), { code: 'P2025' });
      return rows[0];
    },
    async count(args = {}) {
      allowed(args, ['where']);
      const params = new Params();
      return Number((await db.query(`SELECT count(*)::int AS n FROM ${t} WHERE ${where(args.where, params)}`, params.values)).rows[0].n);
    },
    async createMany() { throw new Error('createMany is not used by the host'); },
    async updateMany(args) {
      allowed(args, ['where', 'data']);
      const params = new Params();
      const set = assignments(args.data as Record<string, unknown>, params);
      return { count: (await db.query(`UPDATE ${t} SET ${set} WHERE ${where(args.where, params)}`, params.values)).rowCount ?? 0 };
    },
    async deleteMany(args = {}) {
      allowed(args, ['where']);
      const params = new Params();
      return { count: (await db.query(`DELETE FROM ${t} WHERE ${where(args.where, params)}`, params.values)).rowCount ?? 0 };
    },
  };
}

/** Pool-backed adapter; `$transaction` pins one connection (nested calls join it). */
export class PgTestAdapter implements DatabaseAdapter {
  constructor(private readonly db: PgPoolLike | PgQueryable, private readonly inTransaction = false) {}
  model(name: string) { return model(this.db, name); }
  async query<TRow = Record<string, unknown>>(sql: string, values: readonly unknown[] = []) {
    return { rows: (await this.db.query(sql, [...values])).rows as TRow[] };
  }
  async $transaction<T>(work: (tx: DatabaseAdapter) => Promise<T>): Promise<T> {
    if (this.inTransaction) return work(this);
    const client = await (this.db as PgPoolLike).connect();
    try {
      await client.query('BEGIN');
      const result = await work(new PgTestAdapter(client, true));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
