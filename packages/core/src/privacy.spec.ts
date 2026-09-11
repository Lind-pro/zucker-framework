import { describe, expect, it } from 'vitest';
import { redactFields } from './privacy';

describe('redactFields', () => {
  it('redacts selected keys through nested records and arrays without mutating input', () => {
    const input = { token: 'secret', rows: [{ password: 'hidden', title: 'visible' }], count: 2 };
    expect(redactFields(input, ['token', 'password'])).toEqual({
      token: '[Redacted]',
      rows: [{ password: '[Redacted]', title: 'visible' }],
      count: 2,
    });
    expect(input.token).toBe('secret');
    expect(input.rows[0].password).toBe('hidden');
  });

  it('preserves primitive values and permits caller-owned replacement text', () => {
    expect(redactFields(null, ['token'])).toBeNull();
    expect(redactFields('text', ['token'])).toBe('text');
    expect(redactFields({ token: 12, nested: [null, 3] }, ['token'], '***')).toEqual({
      token: '***',
      nested: [null, 3],
    });
  });
});
