import { type DatabaseAdapter, type ModelOperations, TransactionAwareDatabaseAdapter } from '@zucker/core';

/** Minimal interface for a Prisma-like client */
interface PrismaLikeClient extends Record<string, unknown> {
  $transaction<T>(fn: (tx: Record<string, unknown>) => Promise<T>): Promise<T>;
}

/**
 * 模型名映射表 — 解决代码中使用单数名 vs Prisma schema 中复数名的差异。
 * 当代码调用 db.model('dictionary') 时，PrismaAdapter 自动映射到 prisma.dictionaries。
 * 仅在 Prisma Client 中不存在原始名称时才尝试映射。
 */
const MODEL_NAME_ALIASES: Record<string, string> = {
  dictionary: 'dictionaries',
  dictionaryItem: 'dictionaryItems',
};

export class PrismaAdapter extends TransactionAwareDatabaseAdapter {
  constructor(private readonly prisma: PrismaLikeClient) {
    super();
  }

  model(name: string): ModelOperations {
    let model = (this.prisma as Record<string, unknown>)[name];
    if (!model) {
      // 尝试别名映射
      const alias = MODEL_NAME_ALIASES[name];
      if (alias) {
        model = (this.prisma as Record<string, unknown>)[alias];
      }
    }
    if (!model) {
      throw new Error(`Model "${name}" not found in Prisma client`);
    }
    return model as unknown as ModelOperations;
  }

  protected async doTransaction<R>(fn: (adapter: DatabaseAdapter) => Promise<R>): Promise<R> {
    return this.prisma.$transaction(async (tx) => {
      return fn(new PrismaTransactionAdapter(tx));
    });
  }
}

/**
 * 事务内的 PrismaAdapter — 不再包装 TransactionContext
 * 因为事务上下文已由外层 PrismaAdapter.$transaction 管理
 */
class PrismaTransactionAdapter implements DatabaseAdapter {
  constructor(private readonly tx: Record<string, unknown>) {}

  model(name: string): ModelOperations {
    let model = (this.tx as Record<string, unknown>)[name];
    if (!model) {
      const alias = MODEL_NAME_ALIASES[name];
      if (alias) {
        model = (this.tx as Record<string, unknown>)[alias];
      }
    }
    if (!model) {
      throw new Error(`Model "${name}" not found in Prisma transaction client`);
    }
    return model as unknown as ModelOperations;
  }

  async $transaction<R>(fn: (adapter: DatabaseAdapter) => Promise<R>): Promise<R> {
    // 已在事务内，直接执行（嵌套事务扁平化）
    return fn(this);
  }
}
