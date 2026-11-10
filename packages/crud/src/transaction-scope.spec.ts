import { describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter, GenericEntity } from '@zucker-framework/core';
import { CrudService } from './base.service';
import { DynamicQueryParamService, DynamicQueryService } from './dynamic-query.service';
import { FilterOperatorFactory, ALL_OPERATORS } from './operators';
import { transactionScoped, activeTransaction } from './transaction-scope';

interface Row extends GenericEntity { name?: string }
class RowService extends CrudService<Row> {}

function adapter() {
  const modelOps = {
    count: vi.fn().mockResolvedValue(0),
    findMany: vi.fn().mockResolvedValue([]),
    findUnique: vi.fn().mockResolvedValue(null),
    create: vi.fn(async ({ data }) => ({ id: 'new', ...data })),
    update: vi.fn(async ({ data }) => ({ id: 'x', ...data })),
    updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    delete: vi.fn(),
    createMany: vi.fn(),
  };
  const db = { model: vi.fn().mockReturnValue(modelOps), $transaction: vi.fn() } as unknown as DatabaseAdapter;
  return { db, modelOps };
}
const dynamic = (db: DatabaseAdapter) =>
  new DynamicQueryService(db, new DynamicQueryParamService(new FilterOperatorFactory(ALL_OPERATORS.map((Op) => new Op()))));

describe('transaction binding lifetime (N-M10)', () => {
  it('work started inside a transaction but resolved after commit runs on the root adapter', async () => {
    const root = adapter();
    const tx = adapter();
    (root.db.$transaction as ReturnType<typeof vi.fn>).mockImplementation(async (fn: (a: DatabaseAdapter) => unknown) => fn(tx.db));
    const service = new RowService(root.db, dynamic(root.db), 'rows');

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let deferred!: Promise<unknown>;
    await service.transaction(async () => {
      await service.create({ name: 'inside' });
      // Fire-and-forget continuation (e.g. an after-commit dispatch): not awaited by the callback.
      deferred = gate.then(() => service.create({ name: 'late' }));
    });
    expect(tx.modelOps.create).toHaveBeenCalledTimes(1);

    release();
    await deferred;
    expect(tx.modelOps.create).toHaveBeenCalledTimes(1);
    expect(root.modelOps.create).toHaveBeenCalledTimes(1);
    expect(root.modelOps.create).toHaveBeenCalledWith({ data: { name: 'late' } });
  });

  it('the binding is closed even when the transaction callback throws', async () => {
    const root = adapter();
    const tx = adapter();
    (root.db.$transaction as ReturnType<typeof vi.fn>).mockImplementation(async (fn: (a: DatabaseAdapter) => unknown) => fn(tx.db));
    const service = new RowService(root.db, dynamic(root.db), 'rows');

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let deferred!: Promise<unknown>;
    await expect(service.transaction(async () => {
      deferred = gate.then(() => service.create({ name: 'late' }));
      throw new Error('rollback');
    })).rejects.toThrow('rollback');
    release();
    await deferred;
    expect(tx.modelOps.create).not.toHaveBeenCalled();
    expect(root.modelOps.create).toHaveBeenCalledTimes(1);
  });

  it('work inside the callback still uses the transaction adapter and nested calls join it', async () => {
    const root = adapter();
    const tx = adapter();
    (root.db.$transaction as ReturnType<typeof vi.fn>).mockImplementation(async (fn: (a: DatabaseAdapter) => unknown) => fn(tx.db));
    const service = new RowService(root.db, dynamic(root.db), 'rows');
    await service.transaction(async () => {
      expect(activeTransaction(root.db)).toBe(tx.db);
      await service.update('a', { name: 'x' });
      await service.transaction(async () => { await service.update('b', { name: 'y' }); });
    });
    expect(root.db.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.modelOps.update).toHaveBeenCalledTimes(2);
    expect(root.modelOps.update).not.toHaveBeenCalled();
    expect(activeTransaction(root.db)).toBeUndefined();
  });
});

describe('transactionScoped proxy (N-M10)', () => {
  it('reads getters of adapters that use #private fields through the real adapter', async () => {
    class PrivateAdapter {
      #secret = 'shh';
      get secret() { return this.#secret; }
      reveal() { return this.#secret; }
      model() { return adapter().modelOps; }
      async $transaction<R>(fn: (a: DatabaseAdapter) => Promise<R>): Promise<R> { return fn(this as unknown as DatabaseAdapter); }
    }
    class ReadingService extends RowService {
      read() { return (this.db as unknown as PrivateAdapter).secret; }
      call() { return (this.db as unknown as PrivateAdapter).reveal(); }
    }
    const raw = new PrivateAdapter() as unknown as DatabaseAdapter;
    const service = new ReadingService(raw, dynamic(raw), 'rows');
    expect(service.read()).toBe('shh');
    expect(service.call()).toBe('shh');
  });

  it('forwards extra $transaction arguments to the root adapter', async () => {
    const root = adapter();
    const received: unknown[][] = [];
    (root.db as unknown as { $transaction: unknown }).$transaction = vi.fn(async (fn: (a: DatabaseAdapter) => unknown, ...rest: unknown[]) => {
      received.push(rest);
      return fn(root.db);
    });
    const scoped = transactionScoped(root.db);
    const options = { isolationLevel: 'Serializable', timeout: 5000 };
    const result = await (scoped.$transaction as unknown as (fn: () => Promise<string>, opts: unknown) => Promise<string>)(async () => 'done', options);
    expect(result).toBe('done');
    expect(received).toEqual([[options]]);
  });

  it('inside a service transaction $transaction joins the active one instead of opening another', async () => {
    const root = adapter();
    const tx = adapter();
    (root.db.$transaction as ReturnType<typeof vi.fn>).mockImplementation(async (fn: (a: DatabaseAdapter) => unknown) => fn(tx.db));
    const service = new RowService(root.db, dynamic(root.db), 'rows');
    const inner = vi.fn(async (a: DatabaseAdapter) => a);
    await service.transaction(async () => {
      const joined = await ((service as unknown as { db: DatabaseAdapter }).db.$transaction as unknown as (fn: typeof inner, opts: unknown) => Promise<unknown>)(inner, { timeout: 1 });
      expect(joined).toBe(tx.db);
    });
    expect(root.db.$transaction).toHaveBeenCalledTimes(1);
  });
});
