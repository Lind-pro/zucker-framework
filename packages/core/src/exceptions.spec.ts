import { describe, expect, it } from 'vitest';
import {
  BUSINESS_EXCEPTION_BRAND,
  BusinessException,
  NotFoundException,
  ValidationException,
  isBusinessException,
} from './exceptions';

describe('BusinessException brand (N-L10)', () => {
  it('uses the realm-wide Symbol.for brand', () => {
    expect(BUSINESS_EXCEPTION_BRAND).toBe(Symbol.for('zucker.business-exception'));
  });

  it('isBusinessException accepts BusinessException and every subclass, including renamed ones', () => {
    class BusinessException2 extends BusinessException {}
    expect(isBusinessException(new BusinessException('x'))).toBe(true);
    expect(isBusinessException(new BusinessException2('x', 'C', 400))).toBe(true);
    expect(isBusinessException(new NotFoundException('x'))).toBe(true);
    expect(isBusinessException(new ValidationException({ f: ['bad'] }))).toBe(true);
  });

  it('isBusinessException rejects ordinary errors and non-objects', () => {
    for (const value of [new Error('x'), Object.assign(new Error('x'), { status: 400, code: 'C' }), null, undefined, 'x', 5, {}]) {
      expect(isBusinessException(value)).toBe(false);
    }
  });

  it('the brand is non-enumerable and does not appear in serialisation', () => {
    const error = new BusinessException('x', 'C', 400);
    expect(Object.keys(error)).not.toContain(String(BUSINESS_EXCEPTION_BRAND));
    expect(Object.getOwnPropertySymbols(error)).toEqual([]);
    expect(JSON.stringify(error)).not.toContain('business-exception');
  });

  it('keeps status and code on a renamed subclass', () => {
    class BusinessException2 extends BusinessException {}
    const error = new BusinessException2('boom', 'RENAMED', 418);
    expect(error).toMatchObject({ status: 418, code: 'RENAMED', message: 'boom' });
  });
});
