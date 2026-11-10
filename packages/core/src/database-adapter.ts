import { TransactionHolder, type TransactionContext } from './transaction-context';

/** Shared Nest injection token for the framework database adapter port. */
export const DATABASE_ADAPTER = 'DATABASE_ADAPTER';

/**
 * Database model operations interface — abstracts Prisma-like CRUD operations.
 * Each method maps to a corresponding Prisma client method.
 * @template T - The entity type for this model
 */
export interface ModelOperations<T = unknown> {
  findUnique(args: Record<string, unknown>): Promise<T | null>;
  findFirst?(args: Record<string, unknown>): Promise<T | null>;
  findMany(args?: Record<string, unknown>): Promise<T[]>;
  create(args: Record<string, unknown>): Promise<T>;
  update(args: Record<string, unknown>): Promise<T>;
  delete(args: Record<string, unknown>): Promise<T>;
  count(args?: Record<string, unknown>): Promise<number>;
  createMany(args: Record<string, unknown>): Promise<{ count: number }>;
  updateMany(args: Record<string, unknown>): Promise<{ count: number }>;
  deleteMany(args?: Record<string, unknown>): Promise<{ count: number }>;
  aggregate?(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  groupBy?(args: Record<string, unknown>): Promise<Record<string, unknown>[]>;
}

/**
 * Arguments for aggregate queries (_count, _sum, _avg, _min, _max).
 */
export interface AggregateArgs {
  where?: Record<string, unknown>;
  _count?: Record<string, boolean> | boolean;
  _sum?: Record<string, boolean>;
  _avg?: Record<string, boolean>;
  _min?: Record<string, boolean>;
  _max?: Record<string, boolean>;
}

/**
 * Arguments for groupBy queries with optional aggregation.
 */
export interface GroupByArgs {
  by: string[];
  where?: Record<string, unknown>;
  having?: Record<string, unknown>;
  orderBy?: Record<string, 'asc' | 'desc'>[];
  _count?: Record<string, boolean> | boolean;
  _sum?: Record<string, boolean>;
  _avg?: Record<string, boolean>;
  _min?: Record<string, boolean>;
  _max?: Record<string, boolean>;
}

/**
 * Field metadata of a model, as reported by {@link DatabaseAdapter.getModelFields}.
 * `kind` follows Prisma's runtime data model: `scalar` / `enum` columns, `object` relations,
 * `unsupported` native types.
 */
export interface ModelFieldInfo {
  name: string;
  kind: 'scalar' | 'enum' | 'object' | 'unsupported';
  isList: boolean;
}

/**
 * Database adapter interface — provides model access and transaction support.
 * Implementations wrap specific ORMs (e.g., Prisma) behind this abstraction.
 */
export interface DatabaseAdapter {
  /**
   * Get model operations for the specified entity model.
   * @param name - The model/table name
   * @returns CRUD operations for the model
   */
  model(name: string): ModelOperations;

  /**
   * 执行事务，自动管理 TransactionContext 生命周期
   * - commit 后执行 afterCommit 回调
   * - rollback 后执行 afterRollback 回调
   */
  $transaction<T>(fn: (adapter: DatabaseAdapter) => Promise<T>): Promise<T>;

  /**
   * Optional field metadata for a model (the name passed to {@link model}). Used by the CRUD
   * query policy to reject relation and unknown fields in caller-supplied select / sort / filter
   * input. Return `undefined` when the metadata is not available.
   */
  getModelFields?(model: string): readonly ModelFieldInfo[] | undefined;
}

/**
 * 事务感知的 DatabaseAdapter 基类
 * 子类只需实现 doTransaction 即可获得完整的事务上下文管理
 */
export abstract class TransactionAwareDatabaseAdapter implements DatabaseAdapter {
  abstract model(name: string): ModelOperations;

  async $transaction<T>(fn: (adapter: DatabaseAdapter) => Promise<T>): Promise<T> {
    return TransactionHolder.runInTransaction(async (ctx: TransactionContext) => {
      let result: T;
      try {
        result = await this.doTransaction(fn);
      } catch (error) {
        await ctx.executeAfterRollback();
        throw error;
      }
      // The transaction is committed at this point. An afterCommit callback failure must not
      // fire rollback compensation or report the committed transaction as failed.
      try {
        await ctx.executeAfterCommit();
      } catch (error) {
        console.error(
          `[TransactionAwareDatabaseAdapter] afterCommit callback failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      return result;
    });
  }

  /**
   * 子类实现实际的事务执行逻辑
   * TransactionContext 的生命周期由基类管理
   */
  protected abstract doTransaction<T>(fn: (adapter: DatabaseAdapter) => Promise<T>): Promise<T>;
}
