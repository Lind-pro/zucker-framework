import { describe, expect, it } from 'vitest';
import { parseJsonWithArrayRecovery as publicParse } from '../index';
import { parseJsonWithArrayRecovery as parse } from './parse-json-array-recovery';

const first = { id: 'complete', content: 'literal } ] and "quote" and \\ slash', nested: { list: [1, true, null] } };
const firstText = JSON.stringify(first);

describe('parseJsonWithArrayRecovery', () => {
  it('is available at the package public entry', () => {
    expect(publicParse).toBe(parse);
  });

  it.each([
    (json: string) => json,
    (json: string) => `\uFEFF ${json}`,
    (json: string) => `explanation\n\`\`\`json\n${json}\n\`\`\`\nafterword`,
  ])('preserves complete objects including fields after the array', (wrap) => {
    const input = { before: false, items: [first], after: { enabled: true } };
    expect(parse(wrap(JSON.stringify(input)), 'items')).toEqual(input);
    expect(parse(wrap('{"items":[]}'), 'items')).toEqual({ items: [] });
    expect(parse(wrap('{}'), 'items')).toEqual({});
  });

  it.each(['items', 'files', 'pages', 'tools', '', 'a.b[0]+'])('matches a literal top-level key: %s', (key) => {
    const raw = `{"before":{"count":0},${JSON.stringify(key)}:[${firstText},{"id":"partial","content":"unfinished`;
    expect(parse(raw, key)).toEqual({ before: { count: 0 }, [key]: [first] });
  });

  it('decodes escaped keys and ignores nested/lookalike keys', () => {
    const prefix = '{"nested":{"items":[{"id":"nested"}]},"description":"\\\"items\\\": [ is only text",';
    expect(parse(prefix + `"\\u0069tems":[${firstText},{"id":"partial`, 'items')).toEqual({
      nested: { items: [{ id: 'nested' }] }, description: '"items": [ is only text', items: [first],
    });
    expect(parse('{"nested":{"items":[{"id":"complete"},{"id":"partial', 'items')).toBeNull();
  });

  it.each([
    '', '{', '{"id":', '{"id":"partial', '{"id":"escape\\',
    '{"id":"unicode\\u00', '{"value":1e+', '{"value":-', '{"value":0.',
    '{"value":tru', '{"value":fal', '{"value":nul',
    '{"nested":[{"finished":true},{"unfinished":',
  ])('drops an incomplete tail without finishing any values: %s', (tail) => {
    expect(parse(`{"items":[${firstText},${tail}`, 'items')).toEqual({ items: [first] });
  });

  it('recovers fenced/prefixed truncated input and drops properties following the target array', () => {
    expect(parse(`prefix \`\`\`json\n{"before":1,"items":[${firstText}],"after":{"name":"cut`, 'items')).toEqual({ before: 1, items: [first] });
  });

  it.each([
    '', 'plain text', 'null', '42', '[]', '"string"',
    '{"items":[{"id":"partial',
    '{"other":[{"id":"complete"},{"id":"partial',
    '{"items":[],"after":',
    '{"items":{"id":"wrong-type"},"after":',
    '{"items":[null,',
    '{"items":[{"ok":1},"wrong-type',
    '{"items":[{"ok":1}],"items":[{"second":',
    '{"items":[{"ok":1}],"items"',
  ])('returns null when no unambiguous complete object-entry prefix exists: %s', (raw) => {
    expect(parse(raw, 'items')).toBeNull();
  });

  it.each([
    'garbage', '{"n":01', '{"n":+1', '{"n":1.e', '{"n":trueX',
    '{"n":NaN', '{"n":undefined', '{"n":"bad\\q', '{"n":"bad\n',
    '{"n":"bad\\u00XZ', '{"n":}', '{"n":]', '{bad:',
    '{"n":1 "missing-comma":', '{"n":1,}', ']',
  ])('does not mask malformed syntax as truncation: %s', (tail) => {
    expect(parse(`{"items":[${firstText},${tail}`, 'items')).toBeNull();
  });

  it('does not accept a missing separator between complete entries', () => {
    expect(parse(`{"items":[${firstText}{"id":"cut`, 'items')).toBeNull();
  });

  it('bounds recursive work for deeply nested incomplete input', () => {
    expect(parse(`{"items":[${firstText},{"nested":${'['.repeat(140)}`, 'items')).toBeNull();
  });

  it('never creates object entries across every possible cut of a generated payload', () => {
    const records = [first, { id: 'second', content: '\\u1234 } \\"' }, { id: 'third', value: -1.25e-10 }];
    const encoded = records.map((record) => JSON.stringify(record));
    const start = '{"before":true,"items":[';
    const raw = start + encoded.join(',') + '],"after":42}';
    const ends = encoded.map((_, index) => start.length + encoded.slice(0, index + 1).join(',').length);
    for (let cut = 0; cut <= raw.length; cut++) {
      const result = parse(raw.slice(0, cut), 'items');
      const count = ends.filter((end) => end <= cut).length;
      if (!count) expect(result, `cut=${cut}`).toBeNull();
      else expect(result, `cut=${cut}`).toEqual({ before: true, items: records.slice(0, count), ...(cut === raw.length ? { after: 42 } : {}) });
    }
  });

  it('does not assign prototype-sensitive keys to any shared object', () => {
    const recovered = parse('{"__proto__":{"polluted":true},"items":[{"ok":true},{"cut":', 'items');
    expect(recovered && Object.hasOwn(recovered, '__proto__')).toBe(true);
    expect(Object.prototype).not.toHaveProperty('polluted');
  });
});
