import { describe, it, expect, vi } from 'vitest';
import { TransactionContext, TransactionHolder } from './transaction-context';

describe('TransactionContext', () => {
  it('should register and execute afterCommit callbacks', async () => {
    const ctx = new TransactionContext();
    const fn = vi.fn();
    ctx.afterCommit(fn);
    await ctx.executeAfterCommit();
    expect(fn).toHaveBeenCalledOnce();
  });

  it('should register and execute afterRollback callbacks', async () => {
    const ctx = new TransactionContext();
    const fn = vi.fn();
    ctx.afterRollback(fn);
    await ctx.executeAfterRollback();
    expect(fn).toHaveBeenCalledOnce();
  });

  it('should execute multiple afterCommit callbacks in order', async () => {
    const ctx = new TransactionContext();
    const order: number[] = [];
    ctx.afterCommit(() => { order.push(1); });
    ctx.afterCommit(() => { order.push(2); });
    ctx.afterCommit(() => { order.push(3); });
    await ctx.executeAfterCommit();
    expect(order).toEqual([1, 2, 3]);
  });

  it('should not block subsequent callbacks when one fails on commit', async () => {
    const ctx = new TransactionContext();
    const fn1 = vi.fn();
    const fn2 = vi.fn(() => { throw new Error('fail'); });
    const fn3 = vi.fn();
    ctx.afterCommit(fn1);
    ctx.afterCommit(fn2);
    ctx.afterCommit(fn3);
    await expect(ctx.executeAfterCommit()).rejects.toThrow('fail');
    expect(fn1).toHaveBeenCalled();
    expect(fn3).toHaveBeenCalled();
  });

  it('should throw the first error from afterCommit callbacks', async () => {
    const ctx = new TransactionContext();
    ctx.afterCommit(() => { throw new Error('first'); });
    ctx.afterCommit(() => { throw new Error('second'); });
    await expect(ctx.executeAfterCommit()).rejects.toThrow('first');
  });

  it('should not block subsequent callbacks when one fails on rollback', async () => {
    const ctx = new TransactionContext();
    const fn1 = vi.fn(() => { throw new Error('fail'); });
    const fn2 = vi.fn();
    ctx.afterRollback(fn1);
    ctx.afterRollback(fn2);
    // Rollback swallows errors
    await ctx.executeAfterRollback();
    expect(fn2).toHaveBeenCalled();
  });

  it('should mark completed after executeAfterCommit', async () => {
    const ctx = new TransactionContext();
    expect(ctx.completed).toBe(false);
    await ctx.executeAfterCommit();
    expect(ctx.completed).toBe(true);
  });

  it('should mark completed after executeAfterRollback', async () => {
    const ctx = new TransactionContext();
    await ctx.executeAfterRollback();
    expect(ctx.completed).toBe(true);
  });

  it('should ignore callbacks registered after completion', async () => {
    const ctx = new TransactionContext();
    await ctx.executeAfterCommit();
    const fn = vi.fn();
    ctx.afterCommit(fn);
    // fn was not added since ctx is completed
    // Calling again should not execute the new fn
    expect(fn).not.toHaveBeenCalled();
  });

  it('should handle async callbacks', async () => {
    const ctx = new TransactionContext();
    let value = 0;
    ctx.afterCommit(async () => {
      await new Promise((r) => setTimeout(r, 1));
      value = 42;
    });
    await ctx.executeAfterCommit();
    expect(value).toBe(42);
  });
});

describe('TransactionHolder', () => {
  it('should return undefined when no transaction is active', () => {
    expect(TransactionHolder.get()).toBeUndefined();
  });

  it('should provide context within runInTransaction', async () => {
    await TransactionHolder.runInTransaction(async (ctx) => {
      expect(ctx).toBeInstanceOf(TransactionContext);
      expect(TransactionHolder.get()).toBe(ctx);
    });
  });

  it('should execute afterCommit immediately when no transaction', async () => {
    const fn = vi.fn();
    await TransactionHolder.afterCommit(fn);
    expect(fn).toHaveBeenCalledOnce();
  });

  it('should defer afterCommit when inside transaction', async () => {
    const fn = vi.fn();
    await TransactionHolder.runInTransaction(async (ctx) => {
      await TransactionHolder.afterCommit(fn);
      expect(fn).not.toHaveBeenCalled();
      await ctx.executeAfterCommit();
      expect(fn).toHaveBeenCalledOnce();
    });
  });

  it('should ignore afterRollback when no transaction', () => {
    const fn = vi.fn();
    TransactionHolder.afterRollback(fn);
    // Should not throw and fn should not be called
    expect(fn).not.toHaveBeenCalled();
  });

  it('should register afterRollback when inside transaction', async () => {
    const fn = vi.fn();
    await TransactionHolder.runInTransaction(async (ctx) => {
      TransactionHolder.afterRollback(fn);
      expect(fn).not.toHaveBeenCalled();
      await ctx.executeAfterRollback();
      expect(fn).toHaveBeenCalledOnce();
    });
  });
});
