/**
 * DigestUtils — 摘要哈希工具
 * 参考: hsweb-framework DigestUtils.java
 */
import { createHash, createHmac } from 'node:crypto';

/** 支持的编码格式 */
export type DigestEncoding = 'hex' | 'base64' | 'base64url';

/**
 * Compute MD5 hash of input data.
 * @param input - The string or Buffer to hash
 * @param encoding - Output encoding format (default: 'hex')
 * @returns The MD5 hash string in the specified encoding
 */
export function md5(input: string | Buffer, encoding: DigestEncoding = 'hex'): string {
  return createHash('md5').update(input).digest(encoding);
}

/**
 * Compute SHA-256 hash of input data.
 * @param input - The string or Buffer to hash
 * @param encoding - Output encoding format (default: 'hex')
 * @returns The SHA-256 hash string in the specified encoding
 */
export function sha256(input: string | Buffer, encoding: DigestEncoding = 'hex'): string {
  return createHash('sha256').update(input).digest(encoding);
}

/**
 * Compute SHA-1 hash of input data.
 * @param input - The string or Buffer to hash
 * @param encoding - Output encoding format (default: 'hex')
 * @returns The SHA-1 hash string in the specified encoding
 */
export function sha1(input: string | Buffer, encoding: DigestEncoding = 'hex'): string {
  return createHash('sha1').update(input).digest(encoding);
}

/**
 * Compute HMAC-SHA256 of data using a secret key.
 * @param data - The data string to sign
 * @param secret - The secret key for HMAC
 * @param encoding - Output encoding format (default: 'hex')
 * @returns The HMAC-SHA256 string in the specified encoding
 */
export function hmacSha256(data: string, secret: string, encoding: DigestEncoding = 'hex'): string {
  return createHmac('sha256', secret).update(data).digest(encoding);
}

/**
 * 流式摘要 — 参考 hsweb DigestUtils 的 Consumer<MessageDigest> 模式
 * 支持多次 update 后再 digest
 */
export function digest(
  algorithm: 'md5' | 'sha1' | 'sha256',
  handler: (update: (data: string | Buffer) => void) => void,
  encoding: DigestEncoding = 'hex',
): string {
  const hash = createHash(algorithm);
  handler((data) => hash.update(data));
  return hash.digest(encoding);
}

/**
 * md5 后再 base62 编码 — 对应 hsweb DigestUtils.md5Base62()
 */
export function md5Base62(input: string): string {
  const hash = createHash('md5').update(input).digest();
  return base62Encode(hash);
}

// Base62 字符集
const BASE62_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/**
 * Encode a Buffer as a base62 string.
 * @param input - The Buffer to encode
 * @returns The base62-encoded string
 */
export function base62Encode(input: Buffer): string {
  if (input.length === 0) return '';

  let num = BigInt('0x' + input.toString('hex'));
  if (num === 0n) return BASE62_CHARS[0];

  const chars: string[] = [];
  const base = BigInt(62);
  while (num > 0n) {
    chars.unshift(BASE62_CHARS[Number(num % base)]);
    num = num / base;
  }
  return chars.join('');
}

/**
 * Decode a base62 string back to a Buffer.
 * @param input - The base62-encoded string
 * @returns The decoded Buffer
 * @throws Error if the input contains invalid base62 characters
 */
export function base62Decode(input: string): Buffer {
  if (input.length === 0) return Buffer.alloc(0);

  const base = BigInt(62);
  let num = 0n;
  for (const char of input) {
    const idx = BASE62_CHARS.indexOf(char);
    if (idx === -1) throw new Error(`Invalid base62 character: ${char}`);
    num = num * base + BigInt(idx);
  }

  const hex = num.toString(16);
  // Ensure even length for hex
  const paddedHex = hex.length % 2 === 0 ? hex : '0' + hex;
  return Buffer.from(paddedHex, 'hex');
}
