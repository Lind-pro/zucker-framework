import { describe, it, expect, beforeEach } from 'vitest';
import { TermsEvaluator } from './terms-evaluator';
import type { TermCondition } from './terms-evaluator';

describe('TermsEvaluator', () => {
  let evaluator: TermsEvaluator;

  beforeEach(() => {
    evaluator = new TermsEvaluator();
  });

  it('should evaluate eq operator', () => {
    const condition: TermCondition = {
      terms: [{ column: 'status', termType: 'eq', value: 'active' }],
      type: 'and',
    };
    expect(evaluator.evaluate({ status: 'active' }, condition)).toBe(true);
    expect(evaluator.evaluate({ status: 'inactive' }, condition)).toBe(false);
  });

  it('should evaluate neq operator', () => {
    const condition: TermCondition = {
      terms: [{ column: 'status', termType: 'neq', value: 'active' }],
      type: 'and',
    };
    expect(evaluator.evaluate({ status: 'inactive' }, condition)).toBe(true);
    expect(evaluator.evaluate({ status: 'active' }, condition)).toBe(false);
  });

  it('should evaluate numeric comparison operators (gt, gte, lt, lte)', () => {
    const data = { temperature: 25 };
    expect(
      evaluator.evaluate(data, {
        terms: [{ column: 'temperature', termType: 'gt', value: 20 }],
        type: 'and',
      }),
    ).toBe(true);
    expect(
      evaluator.evaluate(data, {
        terms: [{ column: 'temperature', termType: 'gte', value: 25 }],
        type: 'and',
      }),
    ).toBe(true);
    expect(
      evaluator.evaluate(data, {
        terms: [{ column: 'temperature', termType: 'lt', value: 30 }],
        type: 'and',
      }),
    ).toBe(true);
    expect(
      evaluator.evaluate(data, {
        terms: [{ column: 'temperature', termType: 'lte', value: 25 }],
        type: 'and',
      }),
    ).toBe(true);
    expect(
      evaluator.evaluate(data, {
        terms: [{ column: 'temperature', termType: 'gt', value: 25 }],
        type: 'and',
      }),
    ).toBe(false);
  });

  it('should evaluate like and nlike operators', () => {
    const data = { name: 'hello world' };
    expect(
      evaluator.evaluate(data, {
        terms: [{ column: 'name', termType: 'like', value: 'world' }],
        type: 'and',
      }),
    ).toBe(true);
    expect(
      evaluator.evaluate(data, {
        terms: [{ column: 'name', termType: 'nlike', value: 'foo' }],
        type: 'and',
      }),
    ).toBe(true);
    expect(
      evaluator.evaluate(data, {
        terms: [{ column: 'name', termType: 'like', value: 'missing' }],
        type: 'and',
      }),
    ).toBe(false);
  });

  it('should evaluate in and nin operators', () => {
    const data = { role: 'admin' };
    expect(
      evaluator.evaluate(data, {
        terms: [{ column: 'role', termType: 'in', value: ['admin', 'user'] }],
        type: 'and',
      }),
    ).toBe(true);
    expect(
      evaluator.evaluate(data, {
        terms: [{ column: 'role', termType: 'nin', value: ['guest'] }],
        type: 'and',
      }),
    ).toBe(true);
  });

  it('should evaluate isnull, notnull, empty, nempty operators', () => {
    expect(
      evaluator.evaluate(
        { a: null },
        { terms: [{ column: 'a', termType: 'isnull', value: null }], type: 'and' },
      ),
    ).toBe(true);
    expect(
      evaluator.evaluate(
        { a: 'x' },
        { terms: [{ column: 'a', termType: 'notnull', value: null }], type: 'and' },
      ),
    ).toBe(true);
    expect(
      evaluator.evaluate(
        { a: '' },
        { terms: [{ column: 'a', termType: 'empty', value: null }], type: 'and' },
      ),
    ).toBe(true);
    expect(
      evaluator.evaluate(
        { a: [] },
        { terms: [{ column: 'a', termType: 'empty', value: null }], type: 'and' },
      ),
    ).toBe(true);
    expect(
      evaluator.evaluate(
        { a: 'hello' },
        { terms: [{ column: 'a', termType: 'nempty', value: null }], type: 'and' },
      ),
    ).toBe(true);
  });

  it('should evaluate between operator', () => {
    expect(
      evaluator.evaluate(
        { v: 5 },
        { terms: [{ column: 'v', termType: 'between', value: [1, 10] }], type: 'and' },
      ),
    ).toBe(true);
    expect(
      evaluator.evaluate(
        { v: 15 },
        { terms: [{ column: 'v', termType: 'between', value: [1, 10] }], type: 'and' },
      ),
    ).toBe(false);
  });

  it('should evaluate starts_with, ends_with, contains_all, contains_any', () => {
    expect(
      evaluator.evaluate(
        { s: 'hello world' },
        { terms: [{ column: 's', termType: 'starts_with', value: 'hello' }], type: 'and' },
      ),
    ).toBe(true);
    expect(
      evaluator.evaluate(
        { s: 'hello world' },
        { terms: [{ column: 's', termType: 'ends_with', value: 'world' }], type: 'and' },
      ),
    ).toBe(true);
    expect(
      evaluator.evaluate(
        { arr: [1, 2, 3] },
        { terms: [{ column: 'arr', termType: 'contains_all', value: [1, 2] }], type: 'and' },
      ),
    ).toBe(true);
    expect(
      evaluator.evaluate(
        { arr: [1, 2, 3] },
        { terms: [{ column: 'arr', termType: 'contains_any', value: [3, 4] }], type: 'and' },
      ),
    ).toBe(true);
  });

  it('should combine terms with AND/OR logic', () => {
    const data = { a: 1, b: 2 };
    expect(
      evaluator.evaluate(data, {
        terms: [
          { column: 'a', termType: 'eq', value: 1 },
          { column: 'b', termType: 'eq', value: 2 },
        ],
        type: 'and',
      }),
    ).toBe(true);
    expect(
      evaluator.evaluate(data, {
        terms: [
          { column: 'a', termType: 'eq', value: 1 },
          { column: 'b', termType: 'eq', value: 999 },
        ],
        type: 'and',
      }),
    ).toBe(false);
    expect(
      evaluator.evaluate(data, {
        terms: [
          { column: 'a', termType: 'eq', value: 999 },
          { column: 'b', termType: 'eq', value: 2 },
        ],
        type: 'or',
      }),
    ).toBe(true);
  });

  it('should support nested conditions', () => {
    const condition: TermCondition = {
      terms: [
        {
          column: '',
          termType: 'eq',
          value: null,
          terms: [
            { column: 'x', termType: 'eq', value: 1 },
            { column: 'y', termType: 'eq', value: 2 },
          ],
          termsType: 'or',
        },
      ],
      type: 'and',
    };
    expect(evaluator.evaluate({ x: 1, y: 99 }, condition)).toBe(true);
    expect(evaluator.evaluate({ x: 99, y: 99 }, condition)).toBe(false);
  });

  it('should support nested property access via dot notation', () => {
    const data = { device: { properties: { temperature: 30 } } };
    expect(
      evaluator.evaluate(data, {
        terms: [{ column: 'device.properties.temperature', termType: 'gt', value: 20 }],
        type: 'and',
      }),
    ).toBe(true);
  });

  it('should throw for unknown term type', () => {
    expect(() =>
      evaluator.evaluate(
        { a: 1 },
        { terms: [{ column: 'a', termType: 'unknown_op', value: 1 }], type: 'and' },
      ),
    ).toThrow('Unknown term type: unknown_op');
  });

  it('should support custom operator registration', () => {
    evaluator.registerOperator('regex', (a, b) => {
      if (typeof a !== 'string' || typeof b !== 'string') return false;
      return new RegExp(b).test(a);
    });
    expect(evaluator.getOperatorNames()).toContain('regex');
    expect(
      evaluator.evaluate(
        { email: 'test@example.com' },
        { terms: [{ column: 'email', termType: 'regex', value: '^test@' }], type: 'and' },
      ),
    ).toBe(true);
  });

  it('does not resolve inherited Object.prototype members as operators (L15)', () => {
    const evaluator = new TermsEvaluator();
    for (const termType of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
      expect(() =>
        evaluator.evaluate({ a: 1 }, { type: 'and', terms: [{ column: 'a', termType, value: 1 } as never] }),
      ).toThrow(/Unknown term type/);
    }
  });
});
