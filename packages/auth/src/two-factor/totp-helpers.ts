import { createHash, createHmac, randomBytes, randomInt } from 'node:crypto';

/**
 * Storage-free TOTP enrolment helpers (RFC 6238 / RFC 4226, SHA-1, as expected by common
 * authenticator apps). The package never stores secrets or recovery codes: the product keeps
 * the secret encrypted and only the recovery-code hashes.
 */

const BASE32_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const BASE32_PATTERN = /^[A-Z2-7]+=*$/;

export function base32Encode(buffer: Uint8Array): string {
  let result = '';
  let bits = 0;
  let value = 0;
  for (const byte of buffer) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += BASE32_CHARS[(value >>> bits) & 0x1f];
    }
  }
  if (bits > 0) result += BASE32_CHARS[(value << (5 - bits)) & 0x1f];
  return result;
}

/** Lenient decode (case-insensitive, padding and unknown characters ignored), as before. */
export function base32Decode(encoded: string): Buffer {
  const cleaned = encoded.toUpperCase().replace(/=+$/, '');
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of cleaned) {
    const idx = BASE32_CHARS.indexOf(char);
    if (idx === -1) continue;
    value = ((value << 5) | idx) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

/** New TOTP shared secret: 20 random bytes (160 bits, RFC 4226 §4 recommendation), base32 without padding. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export interface TotpCodeOptions {
  /** Base32 secret. */
  secret: string;
  /** Unix time in milliseconds. Default `Date.now()`. */
  time?: number;
  /** Default 6. */
  digits?: number;
  /** Seconds per step. Default 30. */
  period?: number;
}

/** HOTP value for one counter (RFC 4226, HMAC-SHA-1). */
export function hotpCode(secret: string, counter: number, digits = 6): string {
  const counterBuffer = Buffer.alloc(8);
  let rest = counter;
  for (let i = 7; i >= 0; i--) {
    counterBuffer[i] = rest & 0xff;
    rest = Math.floor(rest / 256);
  }
  const hash = createHmac('sha1', base32Decode(secret)).update(counterBuffer).digest();
  const offset = hash[hash.length - 1] & 0x0f;
  const code =
    ((hash[offset] & 0x7f) << 24) |
    ((hash[offset + 1] & 0xff) << 16) |
    ((hash[offset + 2] & 0xff) << 8) |
    (hash[offset + 3] & 0xff);
  return (code % 10 ** digits).toString().padStart(digits, '0');
}

/** TOTP value at `time` (RFC 6238). Useful for tests and fakes; never send it to a client. */
export function generateTotpCode(options: TotpCodeOptions): string {
  const period = options.period ?? 30;
  const counter = Math.floor((options.time ?? Date.now()) / 1000 / period);
  return hotpCode(options.secret, counter, options.digits ?? 6);
}

export interface TotpProvisioningUriOptions {
  /** Base32 secret from `generateTotpSecret()`. */
  secret: string;
  /** Account label shown in the app, e.g. the user's email or username. */
  account: string;
  /** Product name shown in the app. */
  issuer: string;
  digits?: number;
  period?: number;
}

/**
 * `otpauth://totp/<issuer>:<account>?secret=…&issuer=…&algorithm=SHA1&digits=6&period=30`
 * (Key URI format). Label parts are percent-encoded, so `:` inside them cannot split the label.
 */
export function totpProvisioningUri(options: TotpProvisioningUriOptions): string {
  const secret = typeof options.secret === 'string' ? options.secret.toUpperCase() : '';
  if (!BASE32_PATTERN.test(secret)) throw new TypeError('totpProvisioningUri: secret must be base32');
  const account = typeof options.account === 'string' ? options.account.trim() : '';
  const issuer = typeof options.issuer === 'string' ? options.issuer.trim() : '';
  if (!account) throw new TypeError('totpProvisioningUri: account is required');
  if (!issuer) throw new TypeError('totpProvisioningUri: issuer is required');
  const digits = options.digits ?? 6;
  const period = options.period ?? 30;
  if (!Number.isInteger(digits) || digits < 6 || digits > 8) {
    throw new TypeError('totpProvisioningUri: digits must be 6, 7 or 8');
  }
  if (!Number.isInteger(period) || period <= 0) throw new TypeError('totpProvisioningUri: period must be a positive integer');
  const encodedIssuer = encodeURIComponent(issuer);
  const label = `${encodedIssuer}:${encodeURIComponent(account)}`;
  const query = `secret=${secret.replace(/=+$/, '')}&issuer=${encodedIssuer}&algorithm=SHA1&digits=${digits}&period=${period}`;
  return `otpauth://totp/${label}?${query}`;
}

/** Recovery-code alphabet: digits and lowercase letters without 0/o, 1/l/i (31 symbols). */
export const RECOVERY_CODE_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';
export const RECOVERY_CODE_LENGTH = 10;
const RECOVERY_CODE_PATTERN = new RegExp(`^[${RECOVERY_CODE_ALPHABET}]{${RECOVERY_CODE_LENGTH}}$`);

/**
 * `count` single-use recovery codes, each 10 symbols (~49.5 bits) shown as `xxxxx-xxxxx`.
 * Return them to the user exactly once; store only `hashRecoveryCode(code)`.
 */
export function generateRecoveryCodes(count = 10): string[] {
  if (!Number.isInteger(count) || count < 1 || count > 100) {
    throw new RangeError('generateRecoveryCodes: count must be an integer between 1 and 100');
  }
  const codes = new Set<string>();
  while (codes.size < count) {
    let raw = '';
    for (let i = 0; i < RECOVERY_CODE_LENGTH; i++) {
      raw += RECOVERY_CODE_ALPHABET[randomInt(RECOVERY_CODE_ALPHABET.length)];
    }
    codes.add(`${raw.slice(0, 5)}-${raw.slice(5)}`);
  }
  return [...codes];
}

/**
 * Canonical form of user-typed recovery code (case, spaces and hyphens ignored), or `null`
 * when it cannot be a recovery code. Validate untrusted input with this before any lookup.
 */
export function normalizeRecoveryCode(code: unknown): string | null {
  if (typeof code !== 'string' || code.length > 64) return null;
  const normalized = code.toLowerCase().replace(/[\s-]+/g, '');
  return RECOVERY_CODE_PATTERN.test(normalized) ? normalized : null;
}

/**
 * SHA-256 (hex) of the normalised code. Throws `TypeError` for malformed input, so callers
 * validate with `normalizeRecoveryCode` (or catch) and answer with their generic failure.
 */
export function hashRecoveryCode(code: string): string {
  const normalized = normalizeRecoveryCode(code);
  if (normalized === null) throw new TypeError('hashRecoveryCode: malformed recovery code');
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}
