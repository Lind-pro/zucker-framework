import { describe, it, expect } from 'vitest';
import { ExpressionEvaluator } from './expression-evaluator';
import type { ExpressionCondition } from './expression-evaluator';

describe('ExpressionEvaluator', () => {
  const evaluator = new ExpressionEvaluator();

  // ─── 기본 표현식 평가 ────────────────────────────────────────────────────────

  describe('기본 표현식 평가', () => {
    it('참 리터럴 표현식은 true를 반환해야 한다', () => {
      expect(evaluator.evaluate({}, { expression: 'true' })).toBe(true);
    });

    it('거짓 리터럴 표현식은 false를 반환해야 한다', () => {
      expect(evaluator.evaluate({}, { expression: 'false' })).toBe(false);
    });

    it('숫자 비교 표현식을 평가해야 한다', () => {
      expect(evaluator.evaluate({}, { expression: '1 + 1 === 2' })).toBe(true);
      expect(evaluator.evaluate({}, { expression: '5 > 10' })).toBe(false);
    });

    it('논리 AND 표현식을 평가해야 한다', () => {
      expect(evaluator.evaluate({}, { expression: 'true && false' })).toBe(false);
      expect(evaluator.evaluate({}, { expression: 'true && true' })).toBe(true);
    });

    it('논리 OR 표현식을 평가해야 한다', () => {
      expect(evaluator.evaluate({}, { expression: 'false || true' })).toBe(true);
      expect(evaluator.evaluate({}, { expression: 'false || false' })).toBe(false);
    });
  });

  // ─── context 변수 접근 ──────────────────────────────────────────────────────

  describe('context 변수 접근', () => {
    it('data의 변수를 표현식에서 참조해야 한다', () => {
      const condition: ExpressionCondition = {
        expression: 'temperature > 30',
      };
      expect(evaluator.evaluate({ temperature: 35 }, condition)).toBe(true);
      expect(evaluator.evaluate({ temperature: 25 }, condition)).toBe(false);
    });

    it('여러 변수를 조합한 표현식을 평가해야 한다', () => {
      const condition: ExpressionCondition = {
        expression: 'status === "active" && count >= 5',
      };
      expect(
        evaluator.evaluate({ status: 'active', count: 10 }, condition),
      ).toBe(true);
      expect(
        evaluator.evaluate({ status: 'active', count: 3 }, condition),
      ).toBe(false);
    });

    it('문자열 변수를 표현식에서 비교해야 한다', () => {
      const condition: ExpressionCondition = {
        expression: 'name === "Alice"',
      };
      expect(evaluator.evaluate({ name: 'Alice' }, condition)).toBe(true);
      expect(evaluator.evaluate({ name: 'Bob' }, condition)).toBe(false);
    });

    it('정의되지 않은 변수는 undefined로 처리해야 한다', () => {
      const condition: ExpressionCondition = {
        expression: 'typeof missingVar === "undefined"',
      };
      expect(evaluator.evaluate({}, condition)).toBe(true);
    });
  });

  // ─── 불리언 결과 강제 변환 ───────────────────────────────────────────────────

  describe('불리언 결과 강제 변환', () => {
    it('truthy 값을 반환하는 표현식은 true를 반환해야 한다', () => {
      expect(evaluator.evaluate({ v: 1 }, { expression: 'v' })).toBe(true);
      expect(evaluator.evaluate({}, { expression: '"non-empty"' })).toBe(true);
    });

    it('falsy 값을 반환하는 표현식은 false를 반환해야 한다', () => {
      expect(evaluator.evaluate({ v: 0 }, { expression: 'v' })).toBe(false);
      expect(evaluator.evaluate({}, { expression: '""' })).toBe(false);
      expect(evaluator.evaluate({}, { expression: 'null' })).toBe(false);
    });
  });

  // ─── 보안 샌드박스 ───────────────────────────────────────────────────────────

  describe('보안 샌드박스', () => {
    it('process에 접근하면 undefined이어야 한다', () => {
      // process is blocked, so expression 'process === undefined' should be true
      expect(
        evaluator.evaluate({}, { expression: 'process === undefined' }),
      ).toBe(true);
    });

    it('require에 접근하면 undefined이어야 한다', () => {
      expect(
        evaluator.evaluate({}, { expression: 'typeof require === "undefined"' }),
      ).toBe(true);
    });
  });

  describe('realm escape regressions (H5)', () => {
    const payloads = [
      "this.constructor.constructor('return process.pid')()",
      "constructor.constructor('return Object.keys(process.env).length')()",
      "device.constructor.constructor('return process.version')()",
      "device['constr' + 'uctor']['constr' + 'uctor']('return process')()",
    ];
    for (const expression of payloads) {
      it(`blocks ${expression}`, () => {
        expect(() =>
          evaluator.evaluate({ device: { id: 'd1' } }, { expression }),
        ).toThrow();
      });
    }

    it('bounds infinite loops', () => {
      expect(() =>
        evaluator.evaluate({}, { expression: '(() => { for (;;) {} })()' }),
      ).toThrow(/timed out/);
    });
  });
});
