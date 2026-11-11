import { describe, expect, it } from 'vitest';
import {
  base32Encode,
  generateRecoveryCodes,
  generateTotpCode,
  generateTotpSecret,
  hashRecoveryCode,
  normalizeRecoveryCode,
  totpProvisioningUri,
} from './totp-helpers';
import { TotpValidator } from './totp-validator';

// RFC 6238 Appendix B, SHA-1 seed "12345678901234567890", 8 digits.
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890', 'ascii'));
const RFC_VECTORS: Array<[number, string]> = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
];

describe('TOTP helpers', () => {
  it.each(RFC_VECTORS)('matches RFC 6238 at T=%i', (seconds, expected) => {
    expect(generateTotpCode({ secret: RFC_SECRET, time: seconds * 1000, digits: 8 })).toBe(expected);
  });

  it('generates 160-bit base32 secrets', () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(generateTotpSecret()).not.toBe(secret);
  });

  it('builds an encoded provisioning URI and rejects bad input', () => {
    expect(totpProvisioningUri({ secret: 'JBSWY3DPEHPK3PXP', account: 'ann@example.test', issuer: 'Acme: SaaS' }))
      .toBe('otpauth://totp/Acme%3A%20SaaS:ann%40example.test?secret=JBSWY3DPEHPK3PXP&issuer=Acme%3A%20SaaS&algorithm=SHA1&digits=6&period=30');
    expect(() => totpProvisioningUri({ secret: 'not base32!', account: 'a', issuer: 'b' })).toThrow(TypeError);
    expect(() => totpProvisioningUri({ secret: 'JBSWY3DP', account: ' ', issuer: 'b' })).toThrow(TypeError);
  });

  it('generates unique grouped recovery codes and hashes the normalised form', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) expect(code).toMatch(/^[2-9a-hjkmnp-z]{5}-[2-9a-hjkmnp-z]{5}$/);
    const [code] = codes;
    expect(hashRecoveryCode(code)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashRecoveryCode(` ${code.toUpperCase().replace('-', ' ')} `)).toBe(hashRecoveryCode(code));
    expect(normalizeRecoveryCode('abcde-fghio')).toBeNull(); // i, o are not in the alphabet
    expect(normalizeRecoveryCode(42)).toBeNull();
    expect(() => hashRecoveryCode('short')).toThrow(TypeError);
  });
});

describe('TotpValidator.verifyOnce', () => {
  const secret = 'JBSWY3DPEHPK3PXP';

  it('accepts a code once (replay guard) with a pending secret override', async () => {
    const now = Date.parse('2026-11-10T00:00:00Z');
    const validator = new TotpValidator({ now: () => now });
    const code = generateTotpCode({ secret, time: now });
    expect(await validator.verifyOnce('u1', code)).toBe(false); // resolver knows no secret
    expect(await validator.verifyOnce('u1', code, secret)).toBe(true);
    expect(await validator.verifyOnce('u1', code, secret)).toBe(false);
  });

  it('locks out after maxAttempts wrong codes, even for a correct one', async () => {
    let now = Date.parse('2026-11-10T00:00:00Z');
    const validator = new TotpValidator({ now: () => now, maxAttempts: 3, secretResolver: async () => secret });
    for (let i = 0; i < 3; i++) expect(await validator.verifyOnce('u1', '000000')).toBe(false);
    expect(await validator.verifyOnce('u1', generateTotpCode({ secret, time: now }))).toBe(false);
    now += 15 * 60 * 1000 + 1;
    expect(await validator.verifyOnce('u1', generateTotpCode({ secret, time: now }))).toBe(true);
  });
});
