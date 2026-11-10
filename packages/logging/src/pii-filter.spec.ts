import { describe, expect, it } from 'vitest';
import { PiiFilter } from './pii-filter';

describe('PiiFilter', () => {
  it('replaces NUL characters that PostgreSQL text/jsonb columns reject (22P05), in values and keys', () => {
    const filter = new PiiFilter();
    expect(filter.sanitize('a\u0000b')).toBe('a\uFFFDb');
    const value = filter.sanitizeValue({ body: 'x\u0000y', ['k\u0000']: ['\u0000'] }) as Record<string, unknown>;
    expect(JSON.stringify(value)).not.toContain('\\u0000');
    expect(value).toEqual({ body: 'x\uFFFDy', ['k\uFFFD']: ['\uFFFD'] });
  });
  it('redacts credentials and identifiers in nested values', () => {
    const filter = new PiiFilter();

    expect(
      filter.sanitizeValue({
        email: 'attorney@example.com',
        remoteAddress: '203.0.113.8',
        authorization: 'Bearer secret-token',
        nested: {
          upload_token_hash: 'raw-hash',
          note: 'Contact attorney@example.com from 203.0.113.8',
        },
      }),
    ).toEqual({
      email: '[EMAIL]',
      remoteAddress: '[IP]',
      authorization: '[REDACTED]',
      nested: {
        upload_token_hash: '[REDACTED]',
        note: 'Contact [EMAIL] from [IP]',
      },
    });
  });

  it('handles circular objects without throwing', () => {
    const filter = new PiiFilter();
    const value: Record<string, unknown> = { label: 'safe' };
    value.self = value;

    expect(filter.sanitizeValue(value)).toEqual({
      label: 'safe',
      self: '[CIRCULAR]',
    });
  });

  it('truncates oversized strings before emitting them', () => {
    const filter = new PiiFilter({ maxStringLength: 256 });

    const output = filter.sanitize('x'.repeat(300));

    expect(output).toHaveLength(267);
    expect(output.endsWith('[TRUNCATED]')).toBe(true);
  });

  it('redacts credentials embedded in URLs and authorization strings', () => {
    const filter = new PiiFilter();

    expect(
      filter.sanitize(
        'GET /callback?token=plain-token&x-amz-signature=signature ' +
          'Basic dXNlcjpwYXNz ' +
          'postgresql://user:database-password@db.example.test/app',
      ),
    ).toBe(
      'GET /callback?token=[REDACTED]&x-amz-signature=[REDACTED] ' +
        'Basic [REDACTED] ' +
        'postgresql://user:[REDACTED]@db.example.test/app',
    );
  });

  it('redacts application-defined sensitive content fields', () => {
    const filter = new PiiFilter({
      sensitiveFields: ['prompt', 'claims', 'technicalDescription'],
    });

    expect(
      filter.sanitizeValue({
        prompt: 'full model prompt',
        claims: ['claim 1', 'claim 2'],
        nested: { technical_description: 'secret disclosure' },
        taskId: 'task-1',
      }),
    ).toEqual({
      prompt: '[REDACTED]',
      claims: '[REDACTED]',
      nested: { technical_description: '[REDACTED]' },
      taskId: 'task-1',
    });
  });

  it('bounds arrays and objects before they reach a log sink', () => {
    const filter = new PiiFilter({ maxArrayLength: 2, maxObjectKeys: 2 });

    expect(filter.sanitizeValue([1, 2, 3])).toEqual([1, 2, '[TRUNCATED 1 ITEMS]']);
    expect(filter.sanitizeValue({ a: 1, b: 2, c: 3 })).toEqual({
      a: 1,
      b: 2,
      __truncated__: '1 fields omitted',
    });
  });

  it('redacts in linear time on adversarial input (no quadratic backtracking)', () => {
    const filter = new PiiFilter();
    const inputs = [
      'a'.repeat(16_384),
      'eyJ'.repeat(5_461),
      `${'a'.repeat(63)}@${'b'.repeat(253)}`.repeat(52),
      'a@'.repeat(8_192),
      '-----BEGIN PRIVATE KEY-----'.repeat(600),
      'Bearer '.repeat(2_000),
      '1'.repeat(16_384),
    ];
    const started = performance.now();
    for (let pass = 0; pass < 4; pass += 1) {
      for (const input of inputs) filter.sanitize(input);
    }
    // The previous email pattern alone needed ~500 ms for one 16 KiB pass.
    expect(performance.now() - started).toBeLessThan(400);
  });

  it('bounds the total string work of one record', () => {
    const filter = new PiiFilter({ maxStringLength: 1_000, maxTotalStringLength: 2_000 });
    const output = filter.sanitizeValue({
      a: 'x'.repeat(1_000),
      b: 'y'.repeat(1_000),
      c: 'z'.repeat(1_000),
    }) as Record<string, string>;
    expect(output.a).toBe('x'.repeat(1_000));
    expect(output.b).toBe('y'.repeat(1_000));
    expect(output.c).toBe('[TRUNCATED]');
  });

  it('still redacts common values', () => {
    const filter = new PiiFilter();
    expect(
      filter.sanitize(
        'mail first.last+tag@mail.example.co.uk key sk-proj-abcdefghijklmnopqrstuvwxyz123 ' +
          'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl ' +
          '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY----- done',
      ),
    ).toBe('mail [EMAIL] key [API_KEY] jwt [JWT] [PRIVATE_KEY] done');
  });

  it('keeps long numeric identifiers intact while redacting phone and ID numbers', () => {
    const filter = new PiiFilter();
    expect(filter.sanitize('/orders/1893274650123456789 at 1731234567890')).toBe(
      '/orders/1893274650123456789 at 1731234567890',
    );
    expect(filter.sanitize('call 13800138000, id 11010519491231002X')).toBe(
      'call [PHONE], id [IDCARD]',
    );
  });

  it('redacts sensitive fields by normalized fragment and suffix, case-insensitively', () => {
    const filter = new PiiFilter();
    const output = filter.sanitizeValue({
      newPassword: 'a',
      OldPassword: 'b',
      confirm_password: 'c',
      pwd: 'd',
      'x-api-key': 'e',
      secretAccessKey: 'f',
      SECRET_KEY: 'g',
      idToken: 'h',
      'X-CSRF-Token': 'i',
      otp: 'j',
      smsCode: 'k',
      verificationCode: 'l',
      sessionId: 'm',
      captchaAnswer: 'n',
      clientCredentials: 'o',
      maxTokens: 512,
      statusCode: 400,
      keyword: 'safe',
      code: 'P2002',
    });
    expect(output).toEqual({
      newPassword: '[REDACTED]',
      OldPassword: '[REDACTED]',
      confirm_password: '[REDACTED]',
      pwd: '[REDACTED]',
      'x-api-key': '[REDACTED]',
      secretAccessKey: '[REDACTED]',
      SECRET_KEY: '[REDACTED]',
      idToken: '[REDACTED]',
      'X-CSRF-Token': '[REDACTED]',
      otp: '[REDACTED]',
      smsCode: '[REDACTED]',
      verificationCode: '[REDACTED]',
      sessionId: '[REDACTED]',
      captchaAnswer: '[REDACTED]',
      clientCredentials: '[REDACTED]',
      maxTokens: 512,
      statusCode: 400,
      keyword: 'safe',
      code: 'P2002',
    });
  });

  it('redacts credential-like headers and keeps ordinary ones', () => {
    const filter = new PiiFilter();
    expect(
      filter.sanitizeHeaders({
        authorization: 'Bearer abc',
        'x-api-key': 'k',
        'x-auth-token': 't',
        'x-amz-security-token': 's',
        cookie: 'sid=1',
        'x-goog-api-key': 'g',
        'content-type': 'application/json',
        'user-agent': 'test test@example.com',
        accept: ['a', 'b'],
      }),
    ).toEqual({
      authorization: '[REDACTED]',
      'x-api-key': '[REDACTED]',
      'x-auth-token': '[REDACTED]',
      'x-amz-security-token': '[REDACTED]',
      cookie: '[REDACTED]',
      'x-goog-api-key': '[REDACTED]',
      'content-type': 'application/json',
      'user-agent': 'test [EMAIL]',
      accept: 'a, b',
    });
  });

  it('extend() keeps the base configuration and adds fields', () => {
    const base = new PiiFilter({ sensitiveFields: ['prompt'] });
    const extended = base.extend({ sensitiveFields: ['claims'] });
    expect(extended.sanitizeValue({ prompt: 'p', claims: 'c', title: 't' })).toEqual({
      prompt: '[REDACTED]',
      claims: '[REDACTED]',
      title: 't',
    });
  });

  describe('sanitizeUrl', () => {
    const filter = new PiiFilter();

    it('redacts the listed extra sensitive query keys', () => {
      expect(filter.sanitizeUrl('https://x/cb?code=4/0Abc&state=xyz', ['code', 'state'])).toBe(
        'https://x/cb?code=[REDACTED]&state=[REDACTED]',
      );
    });

    it('leaves ordinary parameters unchanged', () => {
      expect(filter.sanitizeUrl('/a?page=2&keyword=a')).toBe('/a?page=2&keyword=a');
    });

    it('redacts passwords and masks emails', () => {
      expect(filter.sanitizeUrl('/a?newPassword=x&email=a@b.co')).toBe('/a?newPassword=[REDACTED]&email=[EMAIL]');
    });

    it('redacts fragment parameters and tolerates URLs without a query', () => {
      expect(filter.sanitizeUrl('/a#access_token=abc&x=1')).toBe('/a#access_token=[REDACTED]&x=1');
      expect(filter.sanitizeUrl('/a')).toBe('/a');
    });

    it('handles 1 MiB of query in linear time', () => {
      const url = '/a?' + 'a=b&'.repeat((1024 * 1024) / 4);
      const start = Date.now();
      filter.sanitizeUrl(url);
      expect(Date.now() - start).toBeLessThan(200);
    });
  });

  describe('checksum-validated patterns', () => {
    const filter = new PiiFilter();

    it('redacts valid ID card numbers and keeps invalid ones', () => {
      expect(filter.sanitize('id 11010519491231002X')).toBe('id [IDCARD]');
      expect(filter.sanitize('order 175928847299117063')).toBe('order 175928847299117063');
    });

    it('redacts Luhn-valid card numbers and keeps invalid ones', () => {
      expect(filter.sanitize('4111111111111111')).toBe('[CARD]');
      expect(filter.sanitize('4111111111111112')).toBe('4111111111111112');
    });

    it('honours a custom PiiPattern.validate in sanitize and containsPii', () => {
      const custom = new PiiFilter({
        patterns: [
          { type: 'TICKET', regex: /\bTK-\d{4}\b/g, replacement: '[TICKET]', validate: (m) => m.endsWith('7') },
        ],
      });
      expect(custom.sanitize('TK-1237 and TK-1238')).toBe('[TICKET] and TK-1238');
      expect(custom.containsPii('TK-1237')).toBe(true);
      expect(custom.containsPii('TK-1238')).toBe(false);
    });
  });

  describe('private keys and connection strings', () => {
    const filter = new PiiFilter();

    it('redacts an unterminated private key block', () => {
      expect(filter.sanitize('-----BEGIN RSA PRIVATE KEY-----\nabc\ndef')).toBe('[PRIVATE_KEY]');
    });

    it('stays linear on repeated BEGIN lines', () => {
      const text = '-----BEGIN PRIVATE KEY-----\n'.repeat((1024 * 1024) / 28);
      const start = Date.now();
      filter.sanitize(text);
      expect(Date.now() - start).toBeLessThan(1000);
    });

    it('redacts a password with an empty user', () => {
      expect(filter.sanitize('redis://:pw@redis:6379')).toBe('redis://:[REDACTED]@redis:6379');
    });
  });

  describe('field name over-redaction rules', () => {
    const filter = new PiiFilter();

    it('keeps descriptor and flag names readable', () => {
      const input = {
        hasApiKey: true,
        passwordChangedAt: '2020-01-01',
        authorizationUrl: 'https://idp.example/authorize',
        costPerToken: 0.1,
        cookieConsent: 'granted',
        credentialId: 'cred-1',
        password: true,
      };
      expect(filter.sanitizeValue(input)).toEqual(input);
    });

    it('redacts real secrets, including non-string values', () => {
      expect(
        filter.sanitizeValue({ sessionId: 's', apiKey: 'k', newPassword: 'p', accessToken: 't', secret: 5 }),
      ).toEqual({
        sessionId: '[REDACTED]',
        apiKey: '[REDACTED]',
        newPassword: '[REDACTED]',
        accessToken: '[REDACTED]',
        secret: '[REDACTED]',
      });
    });

    it('keeps __proto__ as an own property without changing the prototype', () => {
      const result = new PiiFilter().sanitizeValue(JSON.parse('{"__proto__":{"a":1}}')) as Record<string, unknown>;
      expect(Object.prototype.hasOwnProperty.call(result, '__proto__')).toBe(true);
      expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    });
  });
});
