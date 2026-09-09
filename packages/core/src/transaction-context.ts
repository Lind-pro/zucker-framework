import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * 事务同步回调类型
 * 管理事务提交和回滚回调。
 */
type TransactionCallback = () => void | Promise<void>;

/**
 * 事务上下文 — 持有当前事务作用域内的回调注册
 */
export class TransactionContext {
  private readonly afterCommitCallbacks: TransactionCallback[] = [];
  private readonly afterRollbackCallbacks: TransactionCallback[] = [];
  private _completed = false;

  /**
   * 注册 commit 后执行的回调
   * 如果事务已完成，回调将被忽略
   */
  afterCommit(fn: TransactionCallback): void {
    if (this._completed) return;
    this.afterCommitCallbacks.push(fn);
  }

  /**
   * 注册 rollback 后执行的回调
   * 如果事务已完成，回调将被忽略
   */
  afterRollback(fn: TransactionCallback): void {
    if (this._completed) return;
    this.afterRollbackCallbacks.push(fn);
  }

  /**
   * 执行所有 afterCommit 回调
   *
   * 事务同步器回调规则：
   * - 单个回调失败不阻塞后续回调执行
   * - 所有回调执行完毕后，如有错误则抛出第一个错误
   */
  async executeAfterCommit(): Promise<void> {
    this._completed = true;
    let firstError: unknown;
    for (const fn of this.afterCommitCallbacks) {
      try {
        await fn();
      } catch (err) {
        if (!firstError) firstError = err;
      }
    }
    if (firstError) throw firstError;
  }

  /** 执行所有 afterRollback 回调 */
  async executeAfterRollback(): Promise<void> {
    this._completed = true;
    for (const fn of this.afterRollbackCallbacks) {
      try {
        await fn();
      } catch {
        // rollback 回调失败不应阻塞其他回调
      }
    }
  }

  get completed(): boolean {
    return this._completed;
  }
}

/**
 * 事务上下文持有者 — 基于 AsyncLocalStorage 的事务上下文管理
 *
 * 事务同步管理规则：
 * - 在事务作用域内，afterCommit/afterRollback 注册到当前事务
 * - 无事务时，afterCommit 立即执行（afterCommitWithOutTransaction 语义）
 */
const transactionStorage = new AsyncLocalStorage<TransactionContext>();

export const TransactionHolder = {
  /**
   * 获取当前事务上下文（可能为 undefined）
   */
  get(): TransactionContext | undefined {
    return transactionStorage.getStore();
  },

  /**
   * 在事务上下文中执行函数
   */
  async runInTransaction<T>(fn: (ctx: TransactionContext) => Promise<T>): Promise<T> {
    const ctx = new TransactionContext();
    return transactionStorage.run(ctx, () => fn(ctx));
  },

  /**
   * 注册 afterCommit 回调
   * - 有事务上下文且同步器活跃：延迟到 commit 后执行
   * - 有事务上下文但已完成：立即执行并警告
   * - 无事务上下文：立即执行
   * - 注册/执行失败时降级为立即执行
   */
  async afterCommit(fn: TransactionCallback): Promise<void> {
    const ctx = transactionStorage.getStore();
    if (ctx) {
      // 检查事务是否仍然活跃
      if (!ctx.completed) {
        try {
          ctx.afterCommit(fn);
          return;
        } catch {
          // 注册失败时降级为立即执行
          // log.warn("register TransactionSynchronization error", ...)
        }
      }
      // 事务已完成或注册失败，立即执行
    }
    // 无事务时立即执行
    await fn();
  },

  /**
   * 注册 afterRollback 回调
   * - 有事务上下文：延迟到 rollback 后执行
   * - 无事务上下文：忽略（无事务无需回滚）
   */
  afterRollback(fn: TransactionCallback): void {
    const ctx = transactionStorage.getStore();
    if (ctx) {
      ctx.afterRollback(fn);
    }
  },
};
