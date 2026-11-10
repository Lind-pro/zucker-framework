import { describe, it, expect } from 'vitest';
import { evaluate, evaluateTemplate, clearExpressionCache } from './expression-utils';

describe('evaluate', () => {
  it('should evaluate simple arithmetic', () => {
    expect(evaluate('1 + 2')).toBe(3);
  });

  it('should evaluate with context variables', () => {
    expect(evaluate('a + b', { a: 10, b: 20 })).toBe(30);
  });

  it('should evaluate string expressions', () => {
    expect(evaluate('name.toUpperCase()', { name: 'hello' })).toBe('HELLO');
  });

  it('should evaluate boolean expressions', () => {
    expect(evaluate('age >= 18', { age: 20 })).toBe(true);
    expect(evaluate('age >= 18', { age: 10 })).toBe(false);
  });

  it('should throw for expressions exceeding max length', () => {
    const longExpr = 'a'.repeat(5000);
    expect(() => evaluate(longExpr)).toThrow('Expression too long');
  });

  it('should block dangerous patterns', () => {
    expect(() => evaluate('process.exit()')).toThrow('blocked keyword');
    expect(() => evaluate('require("fs")')).toThrow('blocked keyword');
    expect(() => evaluate('eval("1+1")')).toThrow('blocked keyword');
    expect(() => evaluate('constructor')).toThrow('blocked keyword');
    expect(() => evaluate('globalThis')).toThrow('blocked keyword');
    expect(() => evaluate('global.process')).toThrow('blocked keyword');
    expect(() => evaluate('Reflect.ownKeys({})')).toThrow('blocked keyword');
    expect(() => evaluate('Proxy')).toThrow('blocked keyword');
    expect(() => evaluate('this')).toThrow('blocked keyword');
  });

  it('should throw for invalid expressions', () => {
    expect(() => evaluate('{')).toThrow('Failed to evaluate');
  });

  it('should handle empty context', () => {
    expect(evaluate('42')).toBe(42);
  });

  it('should cache compiled expressions', () => {
    clearExpressionCache();
    const result1 = evaluate('x * 2', { x: 5 });
    const result2 = evaluate('x * 2', { x: 10 });
    expect(result1).toBe(10);
    expect(result2).toBe(20);
  });
});

describe('evaluate isolation', () => {
  const probes = [
    'Math["const"+"ructor"]["const"+"ructor"]("return pro"+"cess")()',
    'Date["const"+"ructor"]("return pro"+"cess")()',
    'obj["const"+"ructor"]["const"+"ructor"]("return pro"+"cess")()',
    'fn["const"+"ructor"]("return pro"+"cess")()',
    'name["const"+"ructor"]["const"+"ructor"]("return pro"+"cess")()',
  ];
  it.each(probes)('cannot reach the host process: %s', (expr) => {
    let result: unknown;
    try {
      result = evaluate(expr, { obj: { a: 1 }, fn: () => 1, name: 'x' });
    } catch {
      result = undefined;
    }
    expect(result).not.toBe(process);
    expect(typeof (result as { pid?: unknown } | undefined)?.pid).not.toBe('number');
  });

  it('copies context data (including dates and nested objects) into the sandbox', () => {
    const when = new Date('2026-01-02T03:04:05Z');
    expect(evaluate('when.getTime()', { when })).toBe(when.getTime());
    expect(evaluate('user.roles.length', { user: { roles: ['a', 'b'] } })).toBe(2);
    expect(evaluate('Math.max(a, b)', { a: 1, b: 3 })).toBe(3);
  });

  it('bounds runaway microtasks', () => {
    expect(() =>
      evaluate('(function f() { return Promise.resolve().then(f); })() && (function () { for (;;) {} })()'),
    ).toThrow('Failed to evaluate');
  });
});

describe('evaluateTemplate', () => {
  it('should replace simple variables', () => {
    const result = evaluateTemplate('Hello, ${name}!', { name: 'World' });
    expect(result).toBe('Hello, World!');
  });

  it('should handle nested property access', () => {
    const result = evaluateTemplate('${user.name}', { user: { name: 'Alice' } });
    expect(result).toBe('Alice');
  });

  it('should return empty string for undefined values', () => {
    const result = evaluateTemplate('${missing}', {});
    expect(result).toBe('');
  });

  it('should return empty string for null values', () => {
    const result = evaluateTemplate('${val}', { val: null });
    expect(result).toBe('');
  });

  it('should evaluate expressions in templates', () => {
    const result = evaluateTemplate('Result: ${a + b}', { a: 1, b: 2 });
    expect(result).toBe('Result: 3');
  });

  it('should handle templates without placeholders', () => {
    expect(evaluateTemplate('no placeholders here')).toBe('no placeholders here');
  });

  it('should handle multiple placeholders', () => {
    const result = evaluateTemplate('${a} and ${b}', { a: 'X', b: 'Y' });
    expect(result).toBe('X and Y');
  });

  it('should handle expression errors gracefully', () => {
    const result = evaluateTemplate('${badExpr(}', {});
    expect(result).toBe('');
  });
});

describe('evaluate results are plain host data (M1)', () => {
  it('a result carrying a function member has no callable map', () => {
    const r = evaluate('({ map: f => f })') as { map?: unknown };
    expect(typeof r.map).not.toBe('function');
  });

  it('object results have host prototypes', () => {
    const r = evaluate('({a:[1]})') as { a: unknown[] };
    expect(Object.getPrototypeOf(r)).toBe(Object.prototype);
    expect(r.a).toBeInstanceOf(Array);
    expect(r.a).toEqual([1]);
  });

  it('a Date result is a host Date with the same time', () => {
    const r = evaluate('new Date(1700000000000)');
    expect(r).toBeInstanceOf(Date);
    expect((r as Date).getTime()).toBe(1700000000000);
  });

  it('a thenable result throws', () => {
    expect(() => evaluate('({ then(r) { r(1) } })')).toThrow(/plain data/);
  });

  it('evaluateTemplate with a toString loop returns quickly', () => {
    const t0 = Date.now();
    try {
      evaluateTemplate('v=${ (a => (a.toString = () => { for (;;) {} }, a))([]) }');
    } catch {
      // throwing (timeout) is acceptable; hanging is not
    }
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('keeps the TypeError message of a failing expression', () => {
    expect(() => evaluate('null.x')).toThrow(/null/);
    try {
      evaluate('null.x');
    } catch (e) {
      expect(String((e as Error).message)).toMatch(/TypeError|Cannot read properties of null/);
    }
  });

  it('function and symbol results are undefined', () => {
    expect(evaluate('(() => 1)')).toBeUndefined();
    expect(evaluate('Symbol("s")')).toBeUndefined();
  });
});
