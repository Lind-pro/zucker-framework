// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { scrypt } from 'node:crypto';
import { ScryptEncoder } from './scrypt-encoder';

describe('ScryptEncoder format compatibility', () => {
  const encoder = new ScryptEncoder();
  it('matches pre-existing salted hashes using the stored hex text as the KDF salt', async () => {
    const salt = '00112233445566778899aabbccddeeff';
    const key = await new Promise<Buffer>((resolve, reject) =>
      scrypt('existing-password', salt, 64, (error, result) =>
        error ? reject(error) : resolve(result),
      ),
    );
    const stored = `${salt}:${key.toString('hex')}`;
    expect(await encoder.matches('existing-password', stored)).toBe(true);
    expect(await encoder.matches('wrong-password', stored)).toBe(false);
  });
  it('uses fresh random salts and supports Unicode passwords', async () => {
    const value = '安全-password-🔐';
    const first = await encoder.encode(value),
      second = await encoder.encode(value);
    expect(first).not.toBe(second);
    expect(first).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/);
    expect(await encoder.matches(value, first)).toBe(true);
  });
  it.each([
    '',
    'plaintext',
    'aa:bb',
    'zz'.repeat(16) + ':' + '00'.repeat(64),
    '00'.repeat(16) + ':' + '00'.repeat(64) + ':extra',
  ])('rejects malformed stored hashes without accepting partial encodings: %s', async (stored) => {
    expect(await encoder.matches('password', stored)).toBe(false);
  });
});
