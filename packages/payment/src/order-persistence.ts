import type { ModelOperations } from '@zucker-framework/core';

export const ORDER_PERSISTENCE = 'PAYMENT_ORDER_PERSISTENCE';

/**
 * Durable order data access. Implementations preserve native money/date/JSON values.
 * A transaction-bound model keeps every operation in the caller's transaction.
 * compareAndSet must execute its predicate and update as one database statement.
 */
export interface OrderPersistence<T> extends Pick<
  ModelOperations<T>,
  'create' | 'findUnique' | 'findMany' | 'update' | 'updateMany' | 'count'
> {
  compareAndSet(
    id: string,
    expected: Record<string, unknown>,
    data: Record<string, unknown>,
  ): Promise<boolean>;
}

/** Uses the existing database port; there is no implicit in-memory fallback. */
export class DatabaseOrderPersistence<T> implements OrderPersistence<T> {
  constructor(
    private readonly model: Pick<
      ModelOperations<T>,
      'create' | 'findUnique' | 'findMany' | 'update' | 'updateMany' | 'count'
    >,
  ) {}

  create(args: Record<string, unknown>): Promise<T> {
    return this.model.create(args);
  }
  findUnique(args: Record<string, unknown>): Promise<T | null> {
    return this.model.findUnique(args);
  }
  findMany(args?: Record<string, unknown>): Promise<T[]> {
    return this.model.findMany(args);
  }
  update(args: Record<string, unknown>): Promise<T> {
    return this.model.update(args);
  }
  updateMany(args: Record<string, unknown>): Promise<{ count: number }> {
    return this.model.updateMany(args);
  }
  count(args?: Record<string, unknown>): Promise<number> {
    return this.model.count(args);
  }

  async compareAndSet(
    id: string,
    expected: Record<string, unknown>,
    data: Record<string, unknown>,
  ): Promise<boolean> {
    const result = await this.model.updateMany({ where: { ...expected, id }, data });
    return result.count === 1;
  }
}
