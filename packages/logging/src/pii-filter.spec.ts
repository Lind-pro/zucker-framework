import { describe, expect, it } from 'vitest';
import { PiiFilter } from './pii-filter';

describe('PiiFilter', () => {
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
});
