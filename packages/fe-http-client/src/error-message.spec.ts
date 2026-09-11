import { describe, expect, it } from 'vitest';
import { extractErrorMessage } from './error-message';

describe('error message extraction', () => {
  it('prefers response text and joins only nonempty message strings in their existing order', () => {
    expect(
      extractErrorMessage(
        {
          message: 'transport',
          response: { data: { message: [' first ', '', null, 'second', ' '] } },
        },
        { fallback: 'fallback', separator: '；' },
      ),
    ).toBe(' first ；second');
  });

  it('falls back through the direct error message, string input and consumer fallback', () => {
    expect(
      extractErrorMessage(
        { message: 'direct', response: { data: { message: [' ', null] } } },
        { fallback: 'fallback' },
      ),
    ).toBe('direct');
    expect(extractErrorMessage(' literal ', { fallback: 'fallback' })).toBe(' literal ');
    expect(extractErrorMessage({ message: ['one', 'two'] }, { fallback: 'fallback' })).toBe(
      'one; two',
    );
    expect(extractErrorMessage(null, { fallback: 'fallback' })).toBe('fallback');
  });
});
