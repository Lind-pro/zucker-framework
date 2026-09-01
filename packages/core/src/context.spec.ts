import { describe, it, expect } from 'vitest';
import { ContextKey, MapContext, ContextHolder } from './context';

describe('ContextKey', () => {
  it('should create a key with name and default value', () => {
    const key = new ContextKey<string>('test', 'default');
    expect(key.name).toBe('test');
    expect(key.defaultValue).toBe('default');
  });

  it('should create a key without default value', () => {
    const key = ContextKey.of<number>('count');
    expect(key.name).toBe('count');
    expect(key.defaultValue).toBeUndefined();
  });

  it('should create a string key via static factory', () => {
    const key = ContextKey.string('name', 'anonymous');
    expect(key.name).toBe('name');
    expect(key.defaultValue).toBe('anonymous');
  });

  it('should create a number key via static factory', () => {
    const key = ContextKey.number('age', 0);
    expect(key.name).toBe('age');
    expect(key.defaultValue).toBe(0);
  });

  it('should create a bool key via static factory', () => {
    const key = ContextKey.bool('active', false);
    expect(key.name).toBe('active');
    expect(key.defaultValue).toBe(false);
  });
});

describe('MapContext', () => {
  it('should set and get a value', () => {
    const ctx = new MapContext();
    const key = ContextKey.string('name');
    ctx.set(key, 'Alice');
    expect(ctx.get(key)).toBe('Alice');
  });

  it('should return undefined for unset key without default', () => {
    const ctx = new MapContext();
    const key = ContextKey.string('missing');
    expect(ctx.get(key)).toBeUndefined();
  });

  it('should return default value for unset key with default', () => {
    const ctx = new MapContext();
    const key = ContextKey.string('role', 'guest');
    expect(ctx.get(key)).toBe('guest');
  });

  it('should return stored value even if key has default', () => {
    const ctx = new MapContext();
    const key = ContextKey.string('role', 'guest');
    ctx.set(key, 'admin');
    expect(ctx.get(key)).toBe('admin');
  });

  it('should compute and store value with getOrDefault', () => {
    const ctx = new MapContext();
    const key = ContextKey.of<number[]>('items');
    const result = ctx.getOrDefault(key, () => [1, 2, 3]);
    expect(result).toEqual([1, 2, 3]);
    // Should return stored value on second call
    const result2 = ctx.getOrDefault(key, () => [4, 5, 6]);
    expect(result2).toEqual([1, 2, 3]);
  });

  it('should remove a value and return it', () => {
    const ctx = new MapContext();
    const key = ContextKey.string('temp');
    ctx.set(key, 'value');
    const removed = ctx.remove(key);
    expect(removed).toBe('value');
    expect(ctx.has(key)).toBe(false);
  });

  it('should return undefined when removing a non-existent key', () => {
    const ctx = new MapContext();
    const key = ContextKey.string('nope');
    expect(ctx.remove(key)).toBeUndefined();
  });

  it('should check key existence with has()', () => {
    const ctx = new MapContext();
    const key = ContextKey.string('check');
    expect(ctx.has(key)).toBe(false);
    ctx.set(key, 'yes');
    expect(ctx.has(key)).toBe(true);
  });

  it('should clear all values', () => {
    const ctx = new MapContext();
    ctx.set(ContextKey.string('a'), 'x');
    ctx.set(ContextKey.string('b'), 'y');
    ctx.clear();
    expect(ctx.getAll().size).toBe(0);
  });

  it('should return a copy of all entries via getAll()', () => {
    const ctx = new MapContext();
    const keyA = ContextKey.string('a');
    const keyB = ContextKey.number('b');
    ctx.set(keyA, 'hello');
    ctx.set(keyB, 42);
    const all = ctx.getAll();
    expect(all.get('a')).toBe('hello');
    expect(all.get('b')).toBe(42);
    // Should be a copy
    all.set('c', 'extra');
    expect(ctx.has(ContextKey.string('c'))).toBe(false);
  });
});

describe('ContextHolder', () => {
  it('should return undefined when no context is active', () => {
    expect(ContextHolder.current()).toBeUndefined();
  });

  it('should throw when requiring context outside scope', () => {
    expect(() => ContextHolder.require()).toThrow('No context available');
  });

  it('should provide context within run()', () => {
    const ctx = new MapContext();
    const key = ContextKey.string('test');
    ctx.set(key, 'inside');
    const result = ContextHolder.run(ctx, () => {
      return ContextHolder.require().get(key);
    });
    expect(result).toBe('inside');
  });

  it('should provide a new MapContext with runWithNew()', () => {
    const result = ContextHolder.runWithNew(() => {
      const ctx = ContextHolder.current();
      expect(ctx).toBeDefined();
      return ctx instanceof MapContext;
    });
    expect(result).toBe(true);
  });

  it('should get value via static shortcut', () => {
    const key = ContextKey.string('val');
    const ctx = new MapContext();
    ctx.set(key, 'found');
    ContextHolder.run(ctx, () => {
      expect(ContextHolder.get(key)).toBe('found');
    });
  });

  it('should return undefined from get() when no context', () => {
    const key = ContextKey.string('missing');
    expect(ContextHolder.get(key)).toBeUndefined();
  });

  it('should set value via static shortcut', () => {
    const key = ContextKey.string('setter');
    const ctx = new MapContext();
    ContextHolder.run(ctx, () => {
      ContextHolder.set(key, 'written');
      expect(ctx.get(key)).toBe('written');
    });
  });

  it('should not throw when set() is called without context', () => {
    const key = ContextKey.string('noop');
    // Should silently do nothing
    ContextHolder.set(key, 'ignored');
    expect(ContextHolder.get(key)).toBeUndefined();
  });

  it('should isolate context between nested runs', () => {
    const key = ContextKey.string('level');
    const outerCtx = new MapContext();
    outerCtx.set(key, 'outer');

    ContextHolder.run(outerCtx, () => {
      expect(ContextHolder.get(key)).toBe('outer');

      const innerCtx = new MapContext();
      innerCtx.set(key, 'inner');
      ContextHolder.run(innerCtx, () => {
        expect(ContextHolder.get(key)).toBe('inner');
      });

      // Outer context restored
      expect(ContextHolder.get(key)).toBe('outer');
    });
  });

  it('should work with async functions in run()', async () => {
    const key = ContextKey.string('async');
    const ctx = new MapContext();
    ctx.set(key, 'async-value');

    const result = await ContextHolder.run(ctx, async () => {
      await new Promise((r) => setTimeout(r, 1));
      return ContextHolder.get(key);
    });
    expect(result).toBe('async-value');
  });
});
