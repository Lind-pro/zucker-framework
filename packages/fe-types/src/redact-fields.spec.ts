import { describe, expect, it } from 'vitest';
import { redactFields } from './redact-fields';

describe('configured field redaction', () => {
  it('redacts nested objects and arrays while preserving other fields and the original object', () => {
    const input = {
      contact: { email: 'synthetic@example.test', label: 'visible' },
      rows: [{ text: 'private' }],
      count: 2,
      absent: null,
    };
    expect(redactFields(input, ['email', 'text'])).toEqual({
      contact: { email: '[Redacted]', label: 'visible' },
      rows: [{ text: '[Redacted]' }],
      count: 2,
      absent: null,
    });
    expect(input.contact.email).toBe('synthetic@example.test');
    expect(redactFields(input, ['email'], 'removed').contact.email).toBe('removed');
  });

  it('keeps matching case-sensitive and does not treat a data key as an object prototype', () => {
    const input = JSON.parse('{"__proto__":{"email":"private"},"Email":"visible"}');
    const result = redactFields(input, ['email']);
    expect(Object.hasOwn(result, '__proto__')).toBe(true);
    expect(result.__proto__).toEqual({ email: '[Redacted]' });
    expect(result.Email).toBe('visible');
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  });
});
