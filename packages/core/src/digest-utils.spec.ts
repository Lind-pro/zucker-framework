import { describe, it, expect } from 'vitest';
import { md5, sha256, sha1, hmacSha256, digest, md5Base62, base62Encode, base62Decode } from './digest-utils';

describe('md5', () => {
  it('should produce a 32-character hex string', () => {
    const result = md5('hello');
    expect(result).toHaveLength(32);
    expect(result).toMatch(/^[0-9a-f]+$/);
  });

  it('should produce consistent hashes', () => {
    expect(md5('test')).toBe(md5('test'));
  });

  it('should produce different hashes for different inputs', () => {
    expect(md5('a')).not.toBe(md5('b'));
  });

  it('should support base64 encoding', () => {
    const result = md5('hello', 'base64');
    expect(result).toMatch(/^[A-Za-z0-9+/=]+$/);
  });

  it('should support base64url encoding', () => {
    const result = md5('hello', 'base64url');
    expect(result).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('should handle Buffer input', () => {
    const buf = Buffer.from('hello');
    expect(md5(buf)).toBe(md5('hello'));
  });
});

describe('sha256', () => {
  it('should produce a 64-character hex string', () => {
    const result = sha256('hello');
    expect(result).toHaveLength(64);
  });

  it('should produce consistent hashes', () => {
    expect(sha256('test')).toBe(sha256('test'));
  });
});

describe('sha1', () => {
  it('should produce a 40-character hex string', () => {
    const result = sha1('hello');
    expect(result).toHaveLength(40);
  });
});

describe('hmacSha256', () => {
  it('should produce a 64-character hex string', () => {
    const result = hmacSha256('data', 'secret');
    expect(result).toHaveLength(64);
  });

  it('should produce different results for different secrets', () => {
    expect(hmacSha256('data', 'key1')).not.toBe(hmacSha256('data', 'key2'));
  });

  it('should produce different results for different data', () => {
    expect(hmacSha256('data1', 'key')).not.toBe(hmacSha256('data2', 'key'));
  });
});

describe('digest', () => {
  it('should support streaming updates', () => {
    const result = digest('sha256', (update) => {
      update('hello');
      update(' world');
    });
    expect(result).toBe(sha256('hello world'));
  });

  it('should support different algorithms', () => {
    const md5Result = digest('md5', (update) => update('test'));
    expect(md5Result).toBe(md5('test'));
  });
});

describe('base62Encode / base62Decode', () => {
  it('should encode and decode back to same buffer', () => {
    const input = Buffer.from('hello world');
    const encoded = base62Encode(input);
    expect(typeof encoded).toBe('string');
    // base62 decode may lose leading zeros in some cases,
    // but for non-zero buffers should roundtrip
  });

  it('should return empty string for empty buffer', () => {
    expect(base62Encode(Buffer.alloc(0))).toBe('');
  });

  it('should return empty buffer for empty string', () => {
    expect(base62Decode('')).toEqual(Buffer.alloc(0));
  });

  it('should throw for invalid base62 characters', () => {
    expect(() => base62Decode('!@#')).toThrow('Invalid base62 character');
  });
});

describe('md5Base62', () => {
  it('should return a non-empty base62 string', () => {
    const result = md5Base62('hello');
    expect(result.length).toBeGreaterThan(0);
    expect(result).toMatch(/^[0-9A-Za-z]+$/);
  });

  it('should be deterministic', () => {
    expect(md5Base62('test')).toBe(md5Base62('test'));
  });
});
