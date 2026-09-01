import { describe, it, expect } from 'vitest';
import { ErrorCodes, type ErrorCode } from './code-constants';

describe('ErrorCodes', () => {
  it('should have ILLEGAL_ARGUMENT code', () => {
    expect(ErrorCodes.ILLEGAL_ARGUMENT).toBe('illegal_argument');
  });

  it('should have TIMEOUT code', () => {
    expect(ErrorCodes.TIMEOUT).toBe('timeout');
  });

  it('should have UNSUPPORTED code', () => {
    expect(ErrorCodes.UNSUPPORTED).toBe('unsupported');
  });

  it('should have UNAUTHORIZED code', () => {
    expect(ErrorCodes.UNAUTHORIZED).toBe('unauthorized');
  });

  it('should have NOT_FOUND code', () => {
    expect(ErrorCodes.NOT_FOUND).toBe('not_found');
  });

  it('should have exactly 5 error codes', () => {
    expect(Object.keys(ErrorCodes)).toHaveLength(5);
  });

  it('should be readonly (values are string literals)', () => {
    const code: ErrorCode = ErrorCodes.ILLEGAL_ARGUMENT;
    expect(typeof code).toBe('string');
  });

  it('should not contain duplicate values', () => {
    const values = Object.values(ErrorCodes);
    const uniqueValues = new Set(values);
    expect(uniqueValues.size).toBe(values.length);
  });

  it('should have snake_case formatted values', () => {
    for (const value of Object.values(ErrorCodes)) {
      expect(value).toMatch(/^[a-z_]+$/);
    }
  });

  it('should be usable as union type', () => {
    const codes: ErrorCode[] = [
      ErrorCodes.ILLEGAL_ARGUMENT,
      ErrorCodes.TIMEOUT,
      ErrorCodes.UNSUPPORTED,
      ErrorCodes.UNAUTHORIZED,
      ErrorCodes.NOT_FOUND,
    ];
    expect(codes).toHaveLength(5);
    expect(codes.every((c) => typeof c === 'string')).toBe(true);
  });
});
