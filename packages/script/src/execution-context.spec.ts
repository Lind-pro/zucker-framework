import { describe, it, expect } from 'vitest';
import {
  DefaultExecutionContext,
  CompositeExecutionContext,
  createExecutionContext,
  composeContexts,
} from './execution-context';

describe('DefaultExecutionContext', () => {
  it('getAttribute 从初始化层获取属性', () => {
    const ctx = new DefaultExecutionContext({ foo: 'bar', num: 42 });
    expect(ctx.getAttribute('foo')).toBe('bar');
    expect(ctx.getAttribute('num')).toBe(42);
  });

  it('getAttribute 对不存在的属性返回 undefined', () => {
    const ctx = new DefaultExecutionContext({ foo: 'bar' });
    expect(ctx.getAttribute('missing')).toBeUndefined();
  });

  it('setAttribute 写入自身层并可通过 getAttribute 读取', () => {
    const ctx = new DefaultExecutionContext({});
    ctx.setAttribute('key', 'value');
    expect(ctx.getAttribute('key')).toBe('value');
  });

  it('初始化层属性优先于自身层（读优先）', () => {
    const ctx = new DefaultExecutionContext({ key: 'from-layer' });
    ctx.setAttribute('key', 'from-self');
    // layers are searched first, so layer value takes precedence
    expect(ctx.getAttribute('key')).toBe('from-layer');
  });

  it('removeAttribute 移除自身层属性并返回旧值', () => {
    const ctx = new DefaultExecutionContext({});
    ctx.setAttribute('x', 99);
    const old = ctx.removeAttribute('x');
    expect(old).toBe(99);
    expect(ctx.getAttribute('x')).toBeUndefined();
  });

  it('hasAttribute 对存在的属性返回 true', () => {
    const ctx = new DefaultExecutionContext({ a: 1 });
    expect(ctx.hasAttribute('a')).toBe(true);
  });

  it('hasAttribute 对不存在的属性返回 false', () => {
    const ctx = new DefaultExecutionContext({ a: 1 });
    expect(ctx.hasAttribute('z')).toBe(false);
  });

  it('toRecord 将所有层合并为普通对象', () => {
    const ctx = new DefaultExecutionContext({ a: 1, b: 2 });
    ctx.setAttribute('c', 3);
    const record = ctx.toRecord();
    expect(record).toMatchObject({ a: 1, b: 2, c: 3 });
  });

  it('merge 返回组合上下文', () => {
    const ctx1 = new DefaultExecutionContext({ a: 1 });
    const ctx2 = new DefaultExecutionContext({ b: 2 });
    const merged = ctx1.merge(ctx2);
    expect(merged.getAttribute('a')).toBe(1);
    expect(merged.getAttribute('b')).toBe(2);
  });
});

describe('CompositeExecutionContext', () => {
  it('getAttribute 按顺序查找第一个匹配的上下文', () => {
    const ctx1 = new DefaultExecutionContext({ x: 'first' });
    const ctx2 = new DefaultExecutionContext({ x: 'second', y: 'only-in-2' });
    const composite = new CompositeExecutionContext(ctx1, ctx2);
    expect(composite.getAttribute('x')).toBe('first');
    expect(composite.getAttribute('y')).toBe('only-in-2');
  });

  it('setAttribute 写入最后一个上下文', () => {
    const ctx1 = new DefaultExecutionContext({ a: 1 });
    const ctx2 = new DefaultExecutionContext({});
    const composite = new CompositeExecutionContext(ctx1, ctx2);
    composite.setAttribute('newKey', 'newVal');
    expect(ctx2.getAttribute('newKey')).toBe('newVal');
  });

  it('hasAttribute 任意上下文包含属性时返回 true', () => {
    const ctx1 = new DefaultExecutionContext({ a: 1 });
    const ctx2 = new DefaultExecutionContext({ b: 2 });
    const composite = new CompositeExecutionContext(ctx1, ctx2);
    expect(composite.hasAttribute('a')).toBe(true);
    expect(composite.hasAttribute('b')).toBe(true);
    expect(composite.hasAttribute('z')).toBe(false);
  });

  it('toRecord 合并所有上下文，先出现的优先', () => {
    const ctx1 = new DefaultExecutionContext({ a: 'A', shared: 'from-1' });
    const ctx2 = new DefaultExecutionContext({ b: 'B', shared: 'from-2' });
    const composite = new CompositeExecutionContext(ctx1, ctx2);
    const record = composite.toRecord();
    expect(record['a']).toBe('A');
    expect(record['b']).toBe('B');
    // ctx1 should take precedence over ctx2
    expect(record['shared']).toBe('from-1');
  });

  it('merge 将新上下文追加到组合并返回自身', () => {
    const ctx1 = new DefaultExecutionContext({ a: 1 });
    const ctx2 = new DefaultExecutionContext({ b: 2 });
    const ctx3 = new DefaultExecutionContext({ c: 3 });
    const composite = new CompositeExecutionContext(ctx1, ctx2);
    const result = composite.merge(ctx3);
    expect(result).toBe(composite);
    expect(composite.getAttribute('c')).toBe(3);
  });
});

describe('createExecutionContext / composeContexts', () => {
  it('createExecutionContext 返回可用的 DefaultExecutionContext', () => {
    const ctx = createExecutionContext({ hello: 'world' });
    expect(ctx.getAttribute('hello')).toBe('world');
  });

  it('composeContexts 返回可用的 CompositeExecutionContext', () => {
    const ctx1 = createExecutionContext({ a: 1 });
    const ctx2 = createExecutionContext({ b: 2 });
    const composite = composeContexts(ctx1, ctx2);
    expect(composite.getAttribute('a')).toBe(1);
    expect(composite.getAttribute('b')).toBe(2);
  });
});
