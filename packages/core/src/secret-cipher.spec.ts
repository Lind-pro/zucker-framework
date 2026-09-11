// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest';
import { createCipheriv, randomBytes, scryptSync } from 'crypto';
import {
  SecretCipher,
  isLegacyCiphertext as isLegacyFormat,
  isSecureCiphertext as isSecureFormat,
} from './secret-cipher';
let masterKey = 'test-master-key-32-bytes-long-12345';
const cipher = new SecretCipher({ masterKey: () => masterKey, legacyCbc: { salt: 'salt' } });
const encrypt = (value: string) => cipher.encrypt(value);
const decrypt = (value: string) => cipher.decrypt(value);

/**
 * 用当前 MASTER_KEY 生成一个旧格式（固定盐 + aes-256-cbc）密文，
 * 用于兼容性测试
 */
function makeLegacyCiphertext(plaintext: string, masterKey: string): string {
  const key = scryptSync(masterKey, 'salt', 32);
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return `${iv.toString('hex')}:${encrypted}`;
}

describe('secure-crypto', () => {
  beforeEach(() => {
    masterKey = 'test-master-key-32-bytes-long-12345';
  });

  it('round-trips plaintext through encrypt → decrypt', () => {
    const original = 'sk-test-api-key-abc-123';
    const cipher = encrypt(original);
    expect(decrypt(cipher)).toBe(original);
  });

  it('produces different ciphertext for identical plaintext (random salt/IV)', () => {
    const c1 = encrypt('same-input');
    const c2 = encrypt('same-input');
    expect(c1).not.toBe(c2);
    expect(decrypt(c1)).toBe('same-input');
    expect(decrypt(c2)).toBe('same-input');
  });

  it('uses v2 secure format prefix', () => {
    const cipher = encrypt('hello');
    expect(isSecureFormat(cipher)).toBe(true);
    expect(cipher.startsWith('v2.')).toBe(true);
    expect(cipher.split('.')).toHaveLength(5);
  });

  it('rejects tampered ciphertext (GCM auth tag catches flipped bit)', () => {
    const cipher = encrypt('important-secret');
    const parts = cipher.split('.');
    // flip a byte in the ciphertext portion
    const ctBuf = Buffer.from(parts[4], 'base64');
    ctBuf[0] = ctBuf[0] ^ 0x01;
    parts[4] = ctBuf.toString('base64');
    const tampered = parts.join('.');
    expect(() => decrypt(tampered)).toThrow();
  });

  it('rejects tampered auth tag', () => {
    const cipher = encrypt('important-secret');
    const parts = cipher.split('.');
    const tagBuf = Buffer.from(parts[3], 'base64');
    tagBuf[0] = tagBuf[0] ^ 0xff;
    parts[3] = tagBuf.toString('base64');
    const tampered = parts.join('.');
    expect(() => decrypt(tampered)).toThrow();
  });

  it('fails to decrypt with a different master key', () => {
    const cipher = encrypt('secret-value');
    masterKey = 'different-master-key-value-32-ok!!';
    expect(() => decrypt(cipher)).toThrow();
  });

  it('decrypts legacy fixed-salt ciphertext via fallback path', () => {
    const legacy = makeLegacyCiphertext('legacy-api-key', masterKey);
    expect(isLegacyFormat(legacy)).toBe(true);
    expect(decrypt(legacy)).toBe('legacy-api-key');
  });

  it('throws when value is neither new nor legacy format', () => {
    // Round 5 P0-5：之前是 fallback 当明文返回；新行为强制 throw 让数据污染 / 密钥
    // 轮换问题立刻暴露而非静默削弱密码学保证
    expect(() => decrypt('plain-text-never-encrypted')).toThrow(/加密字段格式无效/);
  });

  it('handles empty string', () => {
    const cipher = encrypt('');
    expect(decrypt(cipher)).toBe('');
  });

  it('handles unicode content (Chinese + emoji)', () => {
    const input = '你好世界 🔐 API key 🚀';
    const cipher = encrypt(input);
    expect(decrypt(cipher)).toBe(input);
  });

  it('handles very long content (100KB)', () => {
    const input = 'a'.repeat(100 * 1024);
    const cipher = encrypt(input);
    expect(decrypt(cipher)).toBe(input);
  });

  it('distinguishes format correctly', () => {
    const secure = encrypt('abc');
    expect(isSecureFormat(secure)).toBe(true);
    expect(isLegacyFormat(secure)).toBe(false);

    const legacy = makeLegacyCiphertext('abc', masterKey);
    expect(isLegacyFormat(legacy)).toBe(true);
    expect(isSecureFormat(legacy)).toBe(false);

    expect(isLegacyFormat('not-encrypted')).toBe(false);
    expect(isSecureFormat('not-encrypted')).toBe(false);
  });

  it('rejects malformed v2 payloads (wrong parts count → throws strict error)', () => {
    // v2.aa.bb.cc 只有 4 段，isSecureFormat 返回 false，也不匹配 legacy。
    // Round 5 P0-5：strict 模式抛错避免静默 fallback。
    expect(() => decrypt('v2.aa.bb.cc')).toThrow(/加密字段格式无效/);
  });

  it('rejects v2 payloads with wrong salt/iv lengths', () => {
    // 构造一个 5 段但长度错误的 v2 密文
    const malformed = [
      'v2',
      Buffer.from('short').toString('base64'),
      Buffer.from('short').toString('base64'),
      Buffer.from('tagtagtagtagtagt').toString('base64'),
      Buffer.from('ciphertext').toString('base64'),
    ].join('.');
    expect(() => decrypt(malformed)).toThrow();
  });
});

describe('cipher configuration and existing v2 records', () => {
  it('requires explicit key material and legacy opt-in', () => {
    expect(() => new SecretCipher({ masterKey: '' }).encrypt('secret')).toThrow('key is required');
    const legacy = makeLegacyCiphertext('historical', masterKey);
    expect(() => new SecretCipher({ masterKey }).decrypt(legacy)).toThrow();
  });
  it('reads the pre-existing v2 wire format produced independently', () => {
    const secret = 'synthetic-migration-key';
    const salt = Buffer.alloc(16, 1),
      iv = Buffer.alloc(12, 2);
    const previous = createCipheriv('aes-256-gcm', scryptSync(masterKey, salt, 32), iv);
    const ciphertext = Buffer.concat([previous.update(secret, 'utf8'), previous.final()]);
    const stored = [
      'v2',
      salt.toString('base64'),
      iv.toString('base64'),
      previous.getAuthTag().toString('base64'),
      ciphertext.toString('base64'),
    ].join('.');
    expect(cipher.decrypt(stored)).toBe(secret);
    const parts = stored.split('.');
    parts[3] = Buffer.alloc(4).toString('base64');
    expect(() => cipher.decrypt(parts.join('.'))).toThrow();
  });
});
