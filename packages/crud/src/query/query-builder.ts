import { type DatabaseAdapter, type GenericEntity } from '@zucker-framework/core';
import { coerceComparable } from './coerce-comparable';

/** 查询条件节点 */
interface WhereCondition {
  field: string;
  op: string;
  value: unknown;
}

/** 条件组（AND/OR） */
interface ConditionGroup {
  type: 'and' | 'or';
  conditions: Array<WhereCondition | ConditionGroup>;
}

/** 排序项 */
interface OrderItem {
  field: string;
  direction: 'asc' | 'desc';
}

/** JOIN 定义 */
interface JoinDefinition {
  model: string;
  type: 'left' | 'inner';
  localField: string;
  foreignField: string;
}

/**
 * 链式查询构建器接口
 */
export interface IQueryBuilder<T extends GenericEntity> {
  where<K extends string & keyof T>(field: K, op: string, value: unknown): IQueryBuilder<T>;
  whereEq<K extends string & keyof T>(field: K, value: T[K]): IQueryBuilder<T>;
  in<K extends string & keyof T>(field: K, values: unknown[]): IQueryBuilder<T>;
  notIn<K extends string & keyof T>(field: K, values: unknown[]): IQueryBuilder<T>;
  like<K extends string & keyof T>(field: K, value: string): IQueryBuilder<T>;
  notLike<K extends string & keyof T>(field: K, value: string): IQueryBuilder<T>;
  startsWith<K extends string & keyof T>(field: K, value: string): IQueryBuilder<T>;
  endsWith<K extends string & keyof T>(field: K, value: string): IQueryBuilder<T>;
  isNull<K extends string & keyof T>(field: K): IQueryBuilder<T>;
  isNotNull<K extends string & keyof T>(field: K): IQueryBuilder<T>;
  between<K extends string & keyof T>(field: K, low: unknown, high: unknown): IQueryBuilder<T>;
  and(fn: (q: IQueryBuilder<T>) => IQueryBuilder<T>): IQueryBuilder<T>;
  or(fn: (q: IQueryBuilder<T>) => IQueryBuilder<T>): IQueryBuilder<T>;
  orderBy<K extends string & keyof T>(field: K, direction?: 'asc' | 'desc'): IQueryBuilder<T>;
  select(...fields: Array<string & keyof T>): IQueryBuilder<T>;
  distinct(...fields: Array<string & keyof T>): IQueryBuilder<T>;
  groupBy(...fields: Array<string & keyof T>): IQueryBuilder<T>;
  having(field: string, op: string, value: unknown): IQueryBuilder<T>;
  exists(relation: string, fn?: (q: IQueryBuilder<any>) => IQueryBuilder<any>): IQueryBuilder<T>;
  notExists(relation: string, fn?: (q: IQueryBuilder<any>) => IQueryBuilder<any>): IQueryBuilder<T>;
  limit(n: number): IQueryBuilder<T>;
  offset(n: number): IQueryBuilder<T>;
  include(relation: string): IQueryBuilder<T>;
  join(model: string): IJoinClause<T>;
  fetch(): Promise<T[]>;
  fetchOne(): Promise<T | null>;
  count(): Promise<number>;
  aggregate(args: AggregateQueryArgs): Promise<any>;
  fetchGroupBy(args: GroupByQueryArgs): Promise<any[]>;
}

/** 聚合查询参数 */
export interface AggregateQueryArgs {
  _count?: Record<string, boolean> | boolean;
  _sum?: Record<string, boolean>;
  _avg?: Record<string, boolean>;
  _min?: Record<string, boolean>;
  _max?: Record<string, boolean>;
}

/** groupBy 查询参数 */
export interface GroupByQueryArgs {
  by: string[];
  _count?: Record<string, boolean> | boolean;
  _sum?: Record<string, boolean>;
  _avg?: Record<string, boolean>;
  _min?: Record<string, boolean>;
  _max?: Record<string, boolean>;
}

/** JOIN 子句接口 */
export interface IJoinClause<T extends GenericEntity> {
  on(localField: string, foreignField: string): IQueryBuilder<T>;
}

/**
 * 链式查询构建器实现
 * 通过 DatabaseAdapter 执行查询，将链式 API 转换为 Prisma 兼容的查询参数
 */
export class QueryBuilder<T extends GenericEntity> implements IQueryBuilder<T> {
  private _conditions: ConditionGroup = { type: 'and', conditions: [] };
  private _orderBy: OrderItem[] = [];
  private _selectFields: string[] = [];
  private _distinctFields: string[] = [];
  private _groupByFields: string[] = [];
  private _havingConditions: Array<{ field: string; op: string; value: unknown }> = [];
  private _existsConditions: Array<{ relation: string; where?: Record<string, unknown>; not?: boolean }> = [];
  private _limit?: number;
  private _offset?: number;
  private _includes: string[] = [];
  private _joins: JoinDefinition[] = [];

  constructor(
    private readonly db: DatabaseAdapter,
    private readonly modelName: string,
  ) {}

  where<K extends string & keyof T>(field: K, op: string, value: unknown): this {
    this._conditions.conditions.push({ field, op, value });
    return this;
  }

  whereEq<K extends string & keyof T>(field: K, value: T[K]): this {
    return this.where(field, 'eq', value);
  }

  in<K extends string & keyof T>(field: K, values: unknown[]): this {
    this._conditions.conditions.push({ field, op: 'in', value: values });
    return this;
  }

  notIn<K extends string & keyof T>(field: K, values: unknown[]): this {
    this._conditions.conditions.push({ field, op: 'notIn', value: values });
    return this;
  }

  like<K extends string & keyof T>(field: K, value: string): this {
    this._conditions.conditions.push({ field, op: 'like', value });
    return this;
  }

  notLike<K extends string & keyof T>(field: K, value: string): this {
    this._conditions.conditions.push({ field, op: 'notLike', value });
    return this;
  }

  startsWith<K extends string & keyof T>(field: K, value: string): this {
    this._conditions.conditions.push({ field, op: 'startsWith', value });
    return this;
  }

  endsWith<K extends string & keyof T>(field: K, value: string): this {
    this._conditions.conditions.push({ field, op: 'endsWith', value });
    return this;
  }

  isNull<K extends string & keyof T>(field: K): this {
    this._conditions.conditions.push({ field, op: 'isNull', value: null });
    return this;
  }

  isNotNull<K extends string & keyof T>(field: K): this {
    this._conditions.conditions.push({ field, op: 'isNotNull', value: null });
    return this;
  }

  between<K extends string & keyof T>(field: K, low: unknown, high: unknown): this {
    this._conditions.conditions.push({ field, op: 'between', value: [low, high] });
    return this;
  }

  and(fn: (q: IQueryBuilder<T>) => IQueryBuilder<T>): this {
    const sub = new QueryBuilder<T>(this.db, this.modelName);
    fn(sub);
    this._conditions.conditions.push({ type: 'and', conditions: sub._conditions.conditions });
    return this;
  }

  or(fn: (q: IQueryBuilder<T>) => IQueryBuilder<T>): this {
    const sub = new QueryBuilder<T>(this.db, this.modelName);
    fn(sub);
    this._conditions.conditions.push({ type: 'or', conditions: sub._conditions.conditions });
    return this;
  }

  orderBy<K extends string & keyof T>(field: K, direction: 'asc' | 'desc' = 'asc'): this {
    this._orderBy.push({ field, direction });
    return this;
  }

  select(...fields: Array<string & keyof T>): this {
    this._selectFields.push(...fields);
    return this;
  }

  distinct(...fields: Array<string & keyof T>): this {
    this._distinctFields.push(...fields);
    return this;
  }

  groupBy(...fields: Array<string & keyof T>): this {
    this._groupByFields.push(...fields);
    return this;
  }

  having(field: string, op: string, value: unknown): this {
    this._havingConditions.push({ field, op, value });
    return this;
  }

  exists(relation: string, fn?: (q: IQueryBuilder<any>) => IQueryBuilder<any>): this {
    const sub = fn ? (() => {
      const q = new QueryBuilder<any>(this.db, relation);
      fn(q);
      return this.buildWhere(q._conditions);
    })() : undefined;
    this._existsConditions.push({ relation, where: sub, not: false });
    return this;
  }

  notExists(relation: string, fn?: (q: IQueryBuilder<any>) => IQueryBuilder<any>): this {
    const sub = fn ? (() => {
      const q = new QueryBuilder<any>(this.db, relation);
      fn(q);
      return this.buildWhere(q._conditions);
    })() : undefined;
    this._existsConditions.push({ relation, where: sub, not: true });
    return this;
  }

  limit(n: number): this {
    this._limit = Math.max(0, n);
    return this;
  }

  offset(n: number): this {
    this._offset = Math.max(0, n);
    return this;
  }

  include(relation: string): this {
    this._includes.push(relation);
    return this;
  }

  join(model: string): IJoinClause<T> {
    const self = this;
    return {
      on(localField: string, foreignField: string): IQueryBuilder<T> {
        self._joins.push({ model, type: 'left', localField, foreignField });
        return self;
      },
    };
  }

  /** leftJoin 便捷方法 */
  leftJoin(model: string): IJoinClause<T> {
    const self = this;
    return {
      on(localField: string, foreignField: string): IQueryBuilder<T> {
        self._joins.push({ model, type: 'left', localField, foreignField });
        return self;
      },
    };
  }

  /** innerJoin 便捷方法 */
  innerJoin(model: string): IJoinClause<T> {
    const self = this;
    return {
      on(localField: string, foreignField: string): IQueryBuilder<T> {
        self._joins.push({ model, type: 'inner', localField, foreignField });
        return self;
      },
    };
  }

  /** 执行查询，返回结果列表 */
  async fetch(): Promise<T[]> {
    const args = this.buildQueryArgs();
    return this.db.model(this.modelName).findMany(args) as Promise<T[]>;
  }

  /** 执行查询，返回单条结果 */
  async fetchOne(): Promise<T | null> {
    const args = this.buildQueryArgs();
    args.take = 1;
    const results = await this.db.model(this.modelName).findMany(args) as T[];
    return results[0] ?? null;
  }

  /** 执行计数查询 */
  async count(): Promise<number> {
    const where = this.buildWhere(this._conditions);
    return this.db.model(this.modelName).count({ where });
  }

  /** 执行聚合查询 */
  async aggregate(args: AggregateQueryArgs): Promise<any> {
    const model = this.db.model(this.modelName);
    if (!model.aggregate) {
      throw new Error(`Model "${this.modelName}" does not support aggregate()`);
    }
    const where = this.buildWhere(this._conditions);
    return model.aggregate({
      where: Object.keys(where).length > 0 ? where : undefined,
      ...args,
    });
  }

  /** 执行 groupBy 查询 */
  async fetchGroupBy(args: GroupByQueryArgs): Promise<any[]> {
    const model = this.db.model(this.modelName);
    if (!model.groupBy) {
      throw new Error(`Model "${this.modelName}" does not support groupBy()`);
    }
    const where = this.buildWhere(this._conditions);
    const havingObj = this.buildHaving();
    return model.groupBy({
      where: Object.keys(where).length > 0 ? where : undefined,
      having: Object.keys(havingObj).length > 0 ? havingObj : undefined,
      ...args,
    });
  }

  // ===================== 内部构建方法 =====================

  /** 构建完整的查询参数 */
  private buildQueryArgs(): Record<string, unknown> {
    const args: Record<string, unknown> = {};

    // WHERE 条件（包括 exists 子查询）
    const where = this.buildWhereWithExists();
    if (Object.keys(where).length > 0) {
      args.where = where;
    }

    // DISTINCT
    if (this._distinctFields.length > 0) {
      args.distinct = this._distinctFields;
    }

    // ORDER BY
    if (this._orderBy.length > 0) {
      args.orderBy = this._orderBy.map((o) => ({ [o.field]: o.direction }));
    }

    // SELECT
    if (this._selectFields.length > 0) {
      const select: Record<string, boolean> = {};
      for (const f of this._selectFields) {
        select[f] = true;
      }
      args.select = select;
    }

    // LIMIT / OFFSET
    if (this._limit !== undefined) {
      args.take = this._limit;
    }
    if (this._offset !== undefined) {
      args.skip = this._offset;
    }

    // INCLUDE（关联查询 / JOIN 转换）
    const includeMap = this.buildInclude();
    if (Object.keys(includeMap).length > 0) {
      // 如果有 select，不能同时用 include，需要将 include 合并到 select
      if (args.select) {
        Object.assign(args.select as Record<string, unknown>, includeMap);
      } else {
        args.include = includeMap;
      }
    }

    return args;
  }

  /** 将条件组转换为 Prisma where 对象 */
  private buildWhere(group: ConditionGroup): Record<string, unknown> {
    if (group.conditions.length === 0) return {};

    const prismaConditions: Record<string, unknown>[] = [];

    for (const cond of group.conditions) {
      if ('type' in cond && ('conditions' in cond)) {
        // 嵌套条件组
        const nested = this.buildWhere(cond as ConditionGroup);
        if (Object.keys(nested).length > 0) {
          prismaConditions.push(nested);
        }
      } else {
        // 单个条件
        const wc = cond as WhereCondition;
        prismaConditions.push(this.buildCondition(wc));
      }
    }

    if (prismaConditions.length === 0) return {};
    if (prismaConditions.length === 1 && group.type === 'and') return prismaConditions[0];

    if (group.type === 'or') {
      return { OR: prismaConditions };
    }
    return { AND: prismaConditions };
  }

  /** Allowed Prisma operators — prevents arbitrary operator injection */
  private static readonly ALLOWED_OPS = new Set([
    'eq', 'neq', 'gt', 'gte', 'lt', 'lte',
    'in', 'notIn', 'like', 'isNull', 'isNotNull', 'between',
    'contains', 'startsWith', 'endsWith', 'not',
    'has', 'hasEvery', 'hasSome', 'isEmpty',
    'equals', 'search', 'mode',
  ]);

  /** 将单个条件转换为 Prisma 条件 */
  private buildCondition(cond: WhereCondition): Record<string, unknown> {
    const { field, op, value } = cond;

    switch (op) {
      case 'eq':
        return { [field]: { equals: value } };
      case 'neq':
        return { [field]: { not: value } };
      case 'gt':
        return { [field]: { gt: coerceComparable(value, 'end') } };
      case 'gte':
        return { [field]: { gte: coerceComparable(value, 'start') } };
      case 'lt':
        return { [field]: { lt: coerceComparable(value, 'start') } };
      case 'lte':
        return { [field]: { lte: coerceComparable(value, 'end') } };
      case 'in':
        return { [field]: { in: value } };
      case 'notIn':
        return { [field]: { notIn: value } };
      case 'like':
        return { [field]: { contains: value, mode: 'insensitive' } };
      case 'isNull':
        return { [field]: { equals: null } };
      case 'isNotNull':
        return { [field]: { not: null } };
      case 'between': {
        if (!Array.isArray(value) || value.length !== 2) {
          throw new Error(`between operator requires [low, high] array, got: ${JSON.stringify(value)}`);
        }
        const [low, high] = value;
        return { [field]: { gte: low, lte: high } };
      }
      case 'startsWith':
        return { [field]: { startsWith: value } };
      case 'endsWith':
        return { [field]: { endsWith: value } };
      case 'notLike':
        return { [field]: { not: { contains: value, mode: 'insensitive' } } };
      case 'notEmpty':
        return { AND: [{ [field]: { not: null } }, { [field]: { not: '' } }] };
      default:
        if (!QueryBuilder.ALLOWED_OPS.has(op)) {
          throw new Error(`Unsupported query operator: "${op}"`);
        }
        return { [field]: { [op]: value } };
    }
  }

  /** 构建含 exists 子查询的 WHERE 条件 */
  private buildWhereWithExists(): Record<string, unknown> {
    const baseWhere = this.buildWhere(this._conditions);

    if (this._existsConditions.length === 0) return baseWhere;

    // 将 exists 条件转为 Prisma 关系过滤
    const existsConditions: Record<string, unknown> = {};
    for (const ec of this._existsConditions) {
      const filterKey = ec.not ? 'none' : 'some';
      existsConditions[ec.relation] = {
        [filterKey]: ec.where ?? {},
      };
    }

    if (Object.keys(baseWhere).length === 0) return existsConditions;
    return { AND: [baseWhere, existsConditions] };
  }

  /** 构建 HAVING 条件（用于 groupBy） */
  private buildHaving(): Record<string, unknown> {
    if (this._havingConditions.length === 0) return {};
    const result: Record<string, unknown> = {};
    for (const h of this._havingConditions) {
      const built = this.buildCondition(h);
      result[h.field] = h.field in built
        ? built[h.field]
        : { [h.op]: h.value };
    }
    return result;
  }

  /** 构建 include 对象（将 JOIN 和 include 合并） */
  private buildInclude(): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    // 直接 include
    for (const rel of this._includes) {
      result[rel] = true;
    }

    // JOIN 转换为 Prisma include/select
    for (const join of this._joins) {
      if (join.type === 'inner') {
        // innerJoin: 添加 where 条件确保关联存在
        result[join.model] = {
          select: { [join.foreignField]: true },
        };
      } else {
        // leftJoin: 普通 include
        result[join.model] = true;
      }
    }

    return result;
  }
}
