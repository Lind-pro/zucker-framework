import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { adminPage, toAdminWhere } from './query-filter';

const options = { eq: ['status', 'enabled', 'username'], like: ['username', 'email'] };

describe('toAdminWhere', () => {
  it('keeps allow-listed exact scalar filters and ignores blank search inputs', () => {
    expect(toAdminWhere({ status: 1, enabled: true, username: '' }, options)).toEqual({ status: 1, enabled: true });
    expect(toAdminWhere(undefined, options)).toEqual({});
    expect(toAdminWhere({ status$eq: 1 }, options)).toEqual({ status: 1 });
  });

  it('turns allow-listed $like keys into case-insensitive contains', () => {
    expect(toAdminWhere({ username$like: 'ali', email$like: 'example' }, options)).toEqual({
      username: { contains: 'ali', mode: 'insensitive' },
      email: { contains: 'example', mode: 'insensitive' },
    });
  });

  it.each([
    [{ name$like: 'x' }],
    [{ username$gt: 'x' }],
    [{ username$like$x: 'x' }],
    // Columns that are not allow-listed are never filterable (credentials, login metadata, future secrets).
    [{ password: 'hash' }],
    [{ password$like: 'abc' }],
    [{ lastLoginIp: '10.0.0.1' }],
    [{ credentialVersion: 3 }],
    [{ email: 'a@example.invalid' }],
    // ORM combinators and relation names.
    [{ OR: 'x' }],
    [{ AND: 'x' }],
    [{ NOT: 'x' }],
    [{ apiKeys: 1 }],
    [{ username: { startsWith: 'a' } }],
    [{ username: ['a'] }],
    [{ 'a.b': 'x' }],
    [{ username$like: 'x'.repeat(201) }],
  ])('rejects %o with 400 instead of passing it to the database', (filter) => {
    expect(() => toAdminWhere(filter, options)).toThrow(BadRequestException);
  });

  it('never treats ORM combinators as fields even when a consumer allow-lists them', () => {
    expect(() => toAdminWhere({ OR: 'x' }, { eq: ['OR'], like: ['NOT'] })).toThrow(BadRequestException);
    expect(() => toAdminWhere({ NOT$like: 'x' }, { eq: ['OR'], like: ['NOT'] })).toThrow(BadRequestException);
  });

  it('rejects a non-object filter', () => {
    expect(() => toAdminWhere('name', options)).toThrow(BadRequestException);
  });
});

describe('adminPage', () => {
  it('defaults and bounds zero-based pages', () => {
    expect(adminPage({})).toEqual({ pageIndex: 0, pageSize: 10 });
    expect(adminPage({ pageIndex: 2, pageSize: 50 })).toEqual({ pageIndex: 2, pageSize: 50 });
    for (const body of [{ pageIndex: -1 }, { pageSize: 0 }, { pageSize: 1001 }, { pageIndex: '1' }, { pageSize: 1.5 }])
      expect(() => adminPage(body)).toThrow(BadRequestException);
  });
});
