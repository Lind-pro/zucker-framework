import { describe, it, expect } from 'vitest';
import { createScopedContext } from './scoped-context';

interface TestData {
  userId: string;
  count: number;
}

describe('createScopedContext', () => {
  it('exposes scope name', () => {
    const ctx = createScopedContext<TestData>('test');
    expect(ctx.name).toBe('test');
  });

  it('current() returns undefined outside run()', () => {
    const ctx = createScopedContext<TestData>('test');
    expect(ctx.current()).toBeUndefined();
  });

  it('required() throws outside run() with scope name in message', () => {
    const ctx = createScopedContext<TestData>('dossier');
    expect(() => ctx.required()).toThrow(/dossier/);
  });

  it('current()/required() return data inside run()', async () => {
    const ctx = createScopedContext<TestData>('test');
    await ctx.run({ userId: 'u1', count: 5 }, async () => {
      expect(ctx.current()).toEqual({ userId: 'u1', count: 5 });
      expect(ctx.required().userId).toBe('u1');
    });
  });

  it('returns sync fn return value directly', () => {
    const ctx = createScopedContext<TestData>('test');
    const result = ctx.run({ userId: 'u1', count: 5 }, () => 42);
    expect(result).toBe(42);
  });

  it('returns async fn return value as promise', async () => {
    const ctx = createScopedContext<TestData>('test');
    const result = await ctx.run({ userId: 'u1', count: 5 }, async () => 'ok');
    expect(result).toBe('ok');
  });

  it('pick() returns selected key', async () => {
    const ctx = createScopedContext<TestData>('test');
    await ctx.run({ userId: 'u1', count: 7 }, async () => {
      expect(ctx.pick('userId')).toBe('u1');
      expect(ctx.pick('count')).toBe(7);
    });
  });

  it('pick() throws outside run()', () => {
    const ctx = createScopedContext<TestData>('jobs');
    expect(() => ctx.pick('userId')).toThrow(/jobs/);
  });

  it('nested run() shadows outer data', async () => {
    const ctx = createScopedContext<TestData>('test');
    await ctx.run({ userId: 'outer', count: 1 }, async () => {
      expect(ctx.required().userId).toBe('outer');
      await ctx.run({ userId: 'inner', count: 2 }, async () => {
        expect(ctx.required().userId).toBe('inner');
      });
      expect(ctx.required().userId).toBe('outer');
    });
  });

  it('two scopes are isolated', async () => {
    const a = createScopedContext<{ v: string }>('A');
    const b = createScopedContext<{ v: string }>('B');

    await a.run({ v: 'a' }, async () => {
      expect(a.required().v).toBe('a');
      expect(b.current()).toBeUndefined();

      await b.run({ v: 'b' }, async () => {
        expect(a.required().v).toBe('a');
        expect(b.required().v).toBe('b');
      });
    });
  });

  it('preserves context across async boundaries', async () => {
    const ctx = createScopedContext<TestData>('async-test');
    await ctx.run({ userId: 'u1', count: 1 }, async () => {
      await new Promise((r) => setTimeout(r, 10));
      expect(ctx.required().userId).toBe('u1');
      await Promise.all([
        Promise.resolve().then(() => expect(ctx.required().userId).toBe('u1')),
        Promise.resolve().then(() => expect(ctx.required().count).toBe(1)),
      ]);
    });
  });
});
