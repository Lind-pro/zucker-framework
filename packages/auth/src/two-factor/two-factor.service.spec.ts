import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { MemoryCache } from '@zucker-framework/cache';
import { TotpValidator } from './totp-validator';
import { TwoFactorService } from './two-factor.service';
import type {
  TwoFactorValidator,
  TwoFactorValidatorProvider,
} from './two-factor.interface';

describe('TwoFactorService', () => {
  it('passes userId and operation into provider-created validator', async () => {
    const verify = vi.fn().mockResolvedValue(true);
    const expired = vi.fn().mockResolvedValue(true);
    const createTwoFactorValidator = vi.fn().mockReturnValue({
      getProvider: () => 'totp',
      verify,
      expired,
    } satisfies TwoFactorValidator);
    const provider: TwoFactorValidatorProvider = {
      getProvider: () => 'totp',
      createTwoFactorValidator,
    };
    const service = new TwoFactorService([provider]);

    const validator = service.getValidator('u1', 'transfer', 'totp');
    await service.validate('u1', 'totp', '123456', 'transfer', 30000);

    expect(validator).toBeDefined();
    expect(createTwoFactorValidator).toHaveBeenCalledWith('u1', 'transfer', undefined);
    expect(verify).toHaveBeenCalledWith('123456', 30000);
  });
});

// Independent RFC 6238 reference implementation (SHA-1, 6 digits, 30 s) for the tests.
const SECRET = 'JBSWY3DPEHPK3PXP';
function base32(encoded: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of encoded) {
    value = (value << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) { bits -= 8; out.push((value >>> bits) & 0xff); }
  }
  return Buffer.from(out);
}
function totp(counter: number): string {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const hash = createHmac('sha1', base32(SECRET)).update(buffer).digest();
  const offset = hash[hash.length - 1] & 0x0f;
  const code = ((hash[offset] & 0x7f) << 24) | (hash[offset + 1] << 16) | (hash[offset + 2] << 8) | hash[offset + 3];
  return String(code % 1_000_000).padStart(6, '0');
}

describe('TotpValidator shared stateStore (N-L2)', () => {
  afterEach(() => vi.useRealTimers());

  it('rejects on instance B a code already accepted on instance A', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:10Z'));
    const stateStore = new MemoryCache();
    const a = new TotpValidator({ secretResolver: async () => SECRET, stateStore });
    const b = new TotpValidator({ secretResolver: async () => SECRET, stateStore });
    const code = totp(Math.floor(Date.now() / 1000 / 30));

    expect(await a.createTwoFactorValidator('u1', 'op').verify(code, 60_000)).toBe(true);
    expect(await b.createTwoFactorValidator('u1', 'op').verify(code, 60_000)).toBe(false);
  });

  it('without a shared store the replay guard is per instance (documented limitation)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:10Z'));
    const a = new TotpValidator({ secretResolver: async () => SECRET });
    const b = new TotpValidator({ secretResolver: async () => SECRET });
    const code = totp(Math.floor(Date.now() / 1000 / 30));
    expect(await a.createTwoFactorValidator('u1', 'op').verify(code, 60_000)).toBe(true);
    expect(await b.createTwoFactorValidator('u1', 'op').verify(code, 60_000)).toBe(true);
  });

  it('shares successful validations: expired() is false on B after verify on A, true after the timeout', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:10Z'));
    const stateStore = new MemoryCache();
    const a = new TotpValidator({ secretResolver: async () => SECRET, stateStore });
    const b = new TotpValidator({ secretResolver: async () => SECRET, stateStore });
    const onB = b.createTwoFactorValidator('u1', 'op');
    expect(await onB.expired()).toBe(true);

    const code = totp(Math.floor(Date.now() / 1000 / 30));
    expect(await a.createTwoFactorValidator('u1', 'op').verify(code, 60_000)).toBe(true);
    expect(await onB.expired()).toBe(false);
    // A different operation is not covered by that validation.
    expect(await b.createTwoFactorValidator('u1', 'other-op').expired()).toBe(true);

    vi.advanceTimersByTime(61_000);
    expect(await onB.expired()).toBe(true);
  });
});
