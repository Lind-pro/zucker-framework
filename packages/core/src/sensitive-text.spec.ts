import { describe, expect, it } from 'vitest';
import { maskEmail, maskRecipients, scrubSensitive } from './sensitive-text';

describe('mask utils', () => {
  describe('maskEmail', () => {
    it('保留首字符与域名', () => {
      expect(maskEmail('zucker@gmail.com')).toBe('z***@gmail.com');
      expect(maskEmail('a@b.com')).toBe('a***@b.com');
    });
    it('空值返回占位', () => {
      expect(maskEmail(null)).toBe('(empty)');
      expect(maskEmail(undefined)).toBe('(empty)');
      expect(maskEmail('')).toBe('(empty)');
    });
    it('非法邮箱返回 ***', () => {
      expect(maskEmail('noatsign')).toBe('***');
      expect(maskEmail('@nolocal.com')).toBe('***');
    });
  });

  describe('maskRecipients', () => {
    it('逗号分隔多收件人逐个脱敏', () => {
      expect(maskRecipients('a@x.com, b@y.com')).toBe('a***@x.com, b***@y.com');
    });
  });

  describe('scrubSensitive', () => {
    it('清洗 IPv4', () => {
      expect(scrubSensitive('connect failed 192.168.1.1:587')).toContain('[ip]');
      expect(scrubSensitive('connect failed 192.168.1.1:587')).not.toContain('192.168');
    });
    it('清洗 token/password', () => {
      expect(scrubSensitive('auth token=abc123secret')).toContain('[redacted]');
      expect(scrubSensitive('password: hunter2')).toContain('[redacted]');
    });

    it('清洗 IPv6 / access_token / jwt / cookie', () => {
      expect(scrubSensitive('peer fe80::1ff:fe23:4567:890a failed')).toContain('[ip]');
      expect(scrubSensitive('access_token=eyJhbGci')).toContain('[redacted]');
      expect(scrubSensitive('jwt: eyJ.payload.sig')).toContain('[redacted]');
      expect(scrubSensitive('cookie=session=abc')).toContain('[redacted]');
    });
    it('redacts the credential after an auth scheme and "is" phrasing', () => {
      const bearer = scrubSensitive('Authorization: Bearer abc123SECRET')!;
      expect(bearer).not.toContain('abc123SECRET');
      expect(bearer).toContain('[redacted]');
      expect(scrubSensitive('authorization=Basic dXNlcjpwYXNz')).not.toContain('dXNlcjpwYXNz');
      expect(scrubSensitive('password is hunter2')).not.toContain('hunter2');
      expect(scrubSensitive('cookie: a=1; sid=topsecret')).not.toContain('topsecret');
      expect(scrubSensitive('failed with eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln')).not.toContain('eyJzdWIiOiIxIn0');
    });
    it('截断超长文本', () => {
      const long = 'x'.repeat(500);
      const out = scrubSensitive(long, 100)!;
      expect(out.length).toBeLessThanOrEqual(101); // 100 + 省略号
      expect(out.endsWith('…')).toBe(true);
    });
    it('null 透传', () => {
      expect(scrubSensitive(null)).toBeNull();
    });
  });
});
