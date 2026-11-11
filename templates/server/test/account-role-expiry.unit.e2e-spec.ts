import { describe, expect, it } from 'vitest';
import { AssignRoleError, parseAssignRoleArguments, parseRoleExpiry } from '../src/accounts/assign-role';

/** WP 3.3b implementer checks for `account:role --expires` parsing (Sonnet extends with PG assignment cases). */
describe('account:role --expires', () => {
  const now = new Date('2026-11-10T00:00:00.000Z');
  it('accepts N days and future ISO dates', () => {
    expect(parseRoleExpiry('30d', now).toISOString()).toBe('2026-12-10T00:00:00.000Z');
    expect(parseRoleExpiry('2027-01-01', now).toISOString()).toBe('2027-01-01T00:00:00.000Z');
    expect(parseRoleExpiry('2027-01-01T12:30:00Z', now).toISOString()).toBe('2027-01-01T12:30:00.000Z');
  });
  it('refuses past, malformed and out-of-range values', () => {
    for (const value of ['0d', '3651d', '2026-01-01', 'tomorrow', '2027-13-40', '']) expect(() => parseRoleExpiry(value, now)).toThrow(AssignRoleError);
  });
  it('parses the flag next to --email/--role and refuses duplicates', () => {
    expect(parseAssignRoleArguments(['--email', 'a@example.invalid', '--role=admin', '--expires', '7d']))
      .toEqual({ email: 'a@example.invalid', role: 'admin', expires: '7d' });
    expect(() => parseAssignRoleArguments(['--email', 'a@example.invalid', '--role=admin', '--expires=yesterday'])).toThrow(AssignRoleError);
    expect(() => parseAssignRoleArguments(['--email', 'a@x.invalid', '--email', 'b@x.invalid', '--role=admin'])).toThrow(AssignRoleError);
  });
});
