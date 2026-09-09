import { TransactionHolder } from './transaction-context';

/**
 * 事务工具类 — 提供静态方法访问事务上下文
 *
 * 提供事务提交回调和无事务场景的统一处理。
 * 适用于不便注入 TransactionHolder 的场景（如事件监听器、工具函数）。
 */
export class TransactionUtils {
  /**
   * 注册 afterCommit 回调
   * - 有事务：commit 后执行
   * - 无事务：立即执行
   */
  static async afterCommit(fn: () => void | Promise<void>): Promise<void> {
    return TransactionHolder.afterCommit(fn);
  }

  /**
   * 注册 afterRollback 回调
   * - 有事务：rollback 后执行
   * - 无事务：忽略
   */
  static afterRollback(fn: () => void | Promise<void>): void {
    TransactionHolder.afterRollback(fn);
  }

  /**
   * 当前是否在事务上下文中
   */
  static isInTransaction(): boolean {
    return TransactionHolder.get() !== undefined;
  }
}
