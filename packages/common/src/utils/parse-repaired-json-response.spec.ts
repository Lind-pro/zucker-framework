import { afterEach, describe, expect, it, vi } from 'vitest';
import { jsonrepair } from 'jsonrepair';
import { JsonResponseParseError, parseRepairedJsonResponse } from './parse-repaired-json-response';

vi.mock('jsonrepair', async (importOriginal) => {
  const original = await importOriginal<typeof import('jsonrepair')>();
  return { ...original, jsonrepair: vi.fn(original.jsonrepair) };
});

afterEach(() => vi.mocked(jsonrepair).mockReset());

describe('parseRepairedJsonResponse', () => {
  it('preserves valid JSON values and strips embedded markdown fences/BOM', () => {
    expect(parseRepairedJsonResponse('prefix ```json\n{"empty":"","a":[1,2]}\n``` suffix')).toEqual(
      { empty: '', a: [1, 2] },
    );
    expect(parseRepairedJsonResponse('\uFEFF {"value":null}')).toEqual({ value: null });
  });

  it('uses jsonrepair for generated object syntax and truncated nested structures', () => {
    expect(parseRepairedJsonResponse("{answer: 'ready',}")).toEqual({ answer: 'ready' });
    expect(parseRepairedJsonResponse('{"items":[{"name":"ready"')).toEqual({
      items: [{ name: 'ready' }],
    });
  });

  it('keeps the truncated completion fallback if the repair dependency rejects', () => {
    vi.mocked(jsonrepair).mockImplementation(() => {
      throw new Error('repair rejected');
    });
    expect(parseRepairedJsonResponse('{"title":"partial')).toEqual({ title: 'partial...' });
  });

  it('extracts the first balanced block while respecting brackets in strings', () => {
    vi.mocked(jsonrepair).mockImplementation(() => {
      throw new Error('repair rejected');
    });
    expect(
      parseRepairedJsonResponse('prefix {"message":"a } [ bracket", "ok":true} suffix'),
    ).toEqual({ message: 'a } [ bracket', ok: true });
  });

  it('throws on empty/exhausted repair and keeps raw input out of diagnostics', () => {
    expect(() => parseRepairedJsonResponse(null)).toThrow(JsonResponseParseError);
    vi.mocked(jsonrepair).mockImplementation(() => {
      throw new Error('repair rejected');
    });
    const logger = { warn: vi.fn(), error: vi.fn() };
    expect(() => parseRepairedJsonResponse('private payload without JSON [', logger)).toThrow(
      JsonResponseParseError,
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('private payload');
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('private payload');
  });
});
