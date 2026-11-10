import { describe, it, expect, vi } from 'vitest';
import { TransactionAwareDatabaseAdapter, type ModelOperations, type DatabaseAdapter } from './database-adapter';
import { TransactionHolder } from './transaction-context';

// Concrete implementation for testing
class TestDatabaseAdapter extends TransactionAwareDatabaseAdapter {
  private models = new Map<string, ModelOperations>();

  registerModel(name: string, ops: ModelOperations): void {
    this.models.set(name, ops);
  }

  model(name: string): ModelOperations {
    const m = this.models.get(name);
    if (!m) throw new Error(`Model "${name}" not found`);
    return m;
  }

  protected async doTransaction<T>(fn: (adapter: DatabaseAdapter) => Promise<T>): Promise<T> {
    return fn(this);
  }
}

function createMockModel(): ModelOperations {
  return {
    findUnique: vi.fn().mockResolvedValue(null),
    findMany: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockResolvedValue({ id: '1' }),
    update: vi.fn().mockResolvedValue({ id: '1' }),
    delete: vi.fn().mockResolvedValue({ id: '1' }),
    count: vi.fn().mockResolvedValue(0),
    createMany: vi.fn().mockResolvedValue({ count: 0 }),
    updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
  };
}

describe('TransactionAwareDatabaseAdapter', () => {
  it('should return model operations', () => {
    const adapter = new TestDatabaseAdapter();
    const mockModel = createMockModel();
    adapter.registerModel('user', mockModel);
    expect(adapter.model('user')).toBe(mockModel);
  });

  it('should throw for unknown model', () => {
    const adapter = new TestDatabaseAdapter();
    expect(() => adapter.model('unknown')).toThrow('Model "unknown" not found');
  });

  it('should execute transaction and call afterCommit', async () => {
    const adapter = new TestDatabaseAdapter();
    const afterCommitFn = vi.fn();

    const result = await adapter.$transaction(async (txAdapter) => {
      TransactionHolder.get()?.afterCommit(afterCommitFn);
      return 'done';
    });

    expect(result).toBe('done');
    expect(afterCommitFn).toHaveBeenCalledOnce();
  });

  it('should call afterRollback on transaction error', async () => {
    const adapter = new TestDatabaseAdapter();
    const afterRollbackFn = vi.fn();

    await expect(
      adapter.$transaction(async () => {
        TransactionHolder.get()?.afterRollback(afterRollbackFn);
        throw new Error('tx failed');
      }),
    ).rejects.toThrow('tx failed');

    expect(afterRollbackFn).toHaveBeenCalledOnce();
  });

  it('should not call afterCommit on error', async () => {
    const adapter = new TestDatabaseAdapter();
    const afterCommitFn = vi.fn();

    await expect(
      adapter.$transaction(async () => {
        TransactionHolder.get()?.afterCommit(afterCommitFn);
        throw new Error('fail');
      }),
    ).rejects.toThrow('fail');

    expect(afterCommitFn).not.toHaveBeenCalled();
  });

  it('should not call afterRollback on success', async () => {
    const adapter = new TestDatabaseAdapter();
    const afterRollbackFn = vi.fn();

    await adapter.$transaction(async () => {
      TransactionHolder.get()?.afterRollback(afterRollbackFn);
      return 'ok';
    });

    expect(afterRollbackFn).not.toHaveBeenCalled();
  });

  it('should provide TransactionContext inside $transaction', async () => {
    const adapter = new TestDatabaseAdapter();

    await adapter.$transaction(async () => {
      const ctx = TransactionHolder.get();
      expect(ctx).toBeDefined();
      expect(ctx!.completed).toBe(false);
    });
  });

  it('should return the value from the transaction fn', async () => {
    const adapter = new TestDatabaseAdapter();
    const result = await adapter.$transaction(async () => ({ id: '42' }));
    expect(result).toEqual({ id: '42' });
  });

  it('should support multiple afterCommit callbacks', async () => {
    const adapter = new TestDatabaseAdapter();
    const order: number[] = [];

    await adapter.$transaction(async () => {
      TransactionHolder.get()?.afterCommit(() => { order.push(1); });
      TransactionHolder.get()?.afterCommit(() => { order.push(2); });
    });

    expect(order).toEqual([1, 2]);
  });

  it('should support async doTransaction implementation', async () => {
    const adapter = new TestDatabaseAdapter();
    const mockModel = createMockModel();
    adapter.registerModel('user', mockModel);

    await adapter.$transaction(async (txAdapter) => {
      await txAdapter.model('user').create({ data: { name: 'Test' } });
    });

    expect(mockModel.create).toHaveBeenCalled();
  });

  it('should handle transaction that returns undefined', async () => {
    const adapter = new TestDatabaseAdapter();
    const result = await adapter.$transaction(async () => undefined);
    expect(result).toBeUndefined();
  });

  it('reports a committed transaction as successful when an afterCommit callback fails', async () => {
    const adapter = new TestDatabaseAdapter();
    const afterRollback = vi.fn();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const result = await adapter.$transaction(async () => {
      TransactionHolder.get()?.afterCommit(() => {
        throw new Error('notify failed');
      });
      TransactionHolder.get()?.afterRollback(afterRollback);
      return 'committed';
    });
    expect(result).toBe('committed');
    expect(afterRollback).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

