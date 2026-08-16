import { createTaskFingerprint } from './task-fingerprint';

describe('createTaskFingerprint', () => {
  it('is stable across object key ordering', () => {
    expect(createTaskFingerprint({ patentId: 'p1', input: { b: 2, a: 1 } })).toBe(
      createTaskFingerprint({ input: { a: 1, b: 2 }, patentId: 'p1' }),
    );
  });

  it('distinguishes changed request values', () => {
    expect(createTaskFingerprint({ patentId: 'p1', revision: 1 })).not.toBe(
      createTaskFingerprint({ patentId: 'p1', revision: 2 }),
    );
  });

  it('matches JSON semantics for undefined object fields and array entries', () => {
    expect(createTaskFingerprint({ a: undefined, b: 1 })).toBe(createTaskFingerprint({ b: 1 }));
    expect(createTaskFingerprint([undefined])).toBe(createTaskFingerprint([null]));
  });

  it('rejects unsupported or circular values', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => createTaskFingerprint(circular)).toThrow('circular references');
    expect(() => createTaskFingerprint({ count: 1n })).toThrow('bigint');
  });
});
