import { describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { FieldType, type FormDefinition } from './types';
import { toAntdRules } from './validators';
import { definitionInitialValues, normalizeFormValues } from './values';
import { unwrapFormDefinition, useFormDefinition } from './useFormDefinition';

const definition: FormDefinition = {
  id: 'synthetic',
  name: 'Synthetic',
  fields: [
    { key: 'meta', name: 'Meta', type: FieldType.JSON, defaultValue: { a: 1 } },
    { key: 'tags', name: 'Tags', type: FieldType.ARRAY, defaultValue: ['x'] },
    { key: 'scores', name: 'Scores', type: FieldType.ARRAY, elementType: FieldType.NUMBER },
    { key: 'doc', name: 'Doc', type: FieldType.FILE },
    { key: 'docs', name: 'Docs', type: FieldType.FILE, extra: { maxCount: 3 } },
    { key: 'title', name: 'Title', type: FieldType.STRING, defaultValue: 'Hello' },
  ],
};

describe('validator parameters follow the server contract', () => {
  it('reads min/max/pattern and still accepts the legacy value spelling', () => {
    expect(
      toAntdRules([
        { type: 'minLength', message: 'a', params: { min: 3 } },
        { type: 'maxLength', message: 'b', params: { max: 9 } },
        { type: 'min', message: 'c', params: { min: 1 } },
        { type: 'max', message: 'd', params: { max: 5 } },
        { type: 'minLength', message: 'legacy', params: { value: 2 } },
      ]),
    ).toEqual([
      { min: 3, message: 'a' },
      { max: 9, message: 'b' },
      { type: 'number', min: 1, message: 'c' },
      { type: 'number', max: 5, message: 'd' },
      { min: 2, message: 'legacy' },
    ]);
    const [rule] = toAntdRules([{ type: 'pattern', message: 'p', params: { pattern: '^[a-z]+$' } }]);
    expect((rule as { pattern: RegExp }).pattern.test('abc')).toBe(true);
    expect((rule as { pattern: RegExp }).pattern.test('ABC')).toBe(false);
  });

  it('skips an invalid or missing pattern instead of throwing or accepting everything', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(toAntdRules([{ type: 'pattern', message: 'p', params: { pattern: '([' } }])).toEqual([]);
    expect(toAntdRules([{ type: 'pattern', message: 'p' }, { type: 'minLength', message: 'm' }])).toEqual([]);
    warn.mockRestore();
  });
});

describe('submitted values match the server field types', () => {
  it('parses JSON, builds typed arrays and resolves files', async () => {
    const file = new File(['x'], 'a.txt');
    const upload = vi.fn(async (f: File) => `stored/${f.name}`);
    const values = await normalizeFormValues(
      definition,
      {
        meta: '{"b":2}',
        tags: ['one', ' ', 'two'],
        scores: '1, 2,3',
        doc: [{ uid: '1', name: 'a.txt', originFileObj: file }],
        docs: [{ uid: '2', name: 'old', url: 'https://cdn.example/old' }, { uid: '3', name: 'a.txt', originFileObj: file }],
        title: 'T',
        extra: 'kept',
      },
      upload,
    );
    expect(values).toEqual({
      meta: { b: 2 },
      tags: ['one', 'two'],
      scores: [1, 2, 3],
      doc: 'stored/a.txt',
      docs: ['https://cdn.example/old', 'stored/a.txt'],
      title: 'T',
      extra: 'kept',
    });
    expect(upload).toHaveBeenCalledTimes(2);
    expect((await normalizeFormValues(definition, { meta: '  ' })).meta).toBeUndefined();
  });

  it('seeds defaults and lets caller initial values win', () => {
    expect(definitionInitialValues(definition, { title: 'Caller' })).toEqual({
      meta: JSON.stringify({ a: 1 }, null, 2),
      tags: ['x'],
      title: 'Caller',
    });
  });
});

describe('definition loading', () => {
  it('unwraps the framework envelope and rejects malformed payloads', () => {
    expect(unwrapFormDefinition({ status: 200, code: 0, message: 'ok', result: definition })).toBe(definition);
    expect(() => unwrapFormDefinition({ status: 200, result: null })).toThrow('Invalid form definition response');
  });

  it('uses the supplied authenticated fetcher with an encoded id and ignores stale responses', async () => {
    const resolvers = new Map<string, (value: unknown) => void>();
    const httpGet = vi.fn((url: string) => new Promise<unknown>((resolve) => resolvers.set(url, resolve)));
    const { result, rerender } = renderHook(({ id }) => useFormDefinition(id, httpGet), {
      initialProps: { id: 'a/b' },
    });
    expect(httpGet).toHaveBeenCalledWith('/api/form/definition/a%2Fb', expect.anything());
    rerender({ id: 'second' });
    resolvers.get('/api/form/definition/second')?.({ result: { ...definition, id: 'second' } });
    await waitFor(() => expect(result.current.definition?.id).toBe('second'));
    resolvers.get('/api/form/definition/a%2Fb')?.({ result: definition });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(result.current.definition?.id).toBe('second');
    // An inline fetcher identity change alone does not refetch.
    expect(httpGet).toHaveBeenCalledTimes(2);
  });
});
