import { describe, expect, it } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { assertQueryField, type QueryFieldUse } from './query-policy';

const USES: QueryFieldUse[] = ['filter', 'sort', 'select'];

describe('default sensitive field pattern (N-M4)', () => {
  const rejected = [
    'keyHash', 'codeHash', 'secretDigest', 'recoveryCodes', 'verificationCode',
    'inviteCode', 'jti', 'encryptedKey', 'signature', 'nonce',
  ];
  const allowed = ['hashtag', 'codeName', 'status', 'tokenCount'];

  for (const field of rejected) {
    it(`rejects ${field} for filter, sort and select`, () => {
      for (const use of USES) {
        expect(() => assertQueryField(field, use)).toThrow(BadRequestException);
      }
    });
  }

  for (const field of allowed) {
    it(`allows ${field} for filter, sort and select`, () => {
      for (const use of USES) {
        expect(assertQueryField(field, use)).toBe(field);
      }
    });
  }

  it('an explicit allow-list entry still wins over the name pattern', () => {
    expect(assertQueryField('keyHash', 'filter', { filterableFields: ['keyHash'] })).toBe('keyHash');
  });

  it('deniedFields wins over an allow-list entry', () => {
    expect(() => assertQueryField('keyHash', 'filter', { filterableFields: ['keyHash'], deniedFields: ['keyHash'] }))
      .toThrow(BadRequestException);
  });
});
