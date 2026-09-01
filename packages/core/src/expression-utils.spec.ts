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
