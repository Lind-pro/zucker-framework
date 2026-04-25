import { describe, it, expect } from 'vitest';
import {
  allowResult,
  denyResult,
  filterResult,
  mergeResults,
  type DataAccessResult,
} from './data-access-result';

describe('DataAccessResult helpers', () => {
  it('allowResult returns allowed: true', () => {
    const r = allowResult();
    expect(r.allowed).toBe(true);
    expect(r.filterConditions).toBeUndefined();
  });

  it('denyResult returns allowed: false', () => {
    const r = denyResult();
    expect(r.allowed).toBe(false);
  });

  it('filterResult returns allowed with conditions', () => {
    const terms = [{ column: 'orgId', termType: 'eq', value: 'o1' }];
    const r = filterResult(terms as any, ['secret']);
    expect(r.allowed).toBe(true);
    expect(r.filterConditions).toHaveLength(1);
    expect(r.denyFields).toEqual(['secret']);
  });

  it('filterResult without denyFields omits the field', () => {
    const r = filterResult([{ column: 'x', termType: 'eq', value: '1' }] as any);
    expect(r.denyFields).toBeUndefined();
  });
});

describe('mergeResults', () => {
  it('returns allowResult for empty array', () => {
    const r = mergeResults([]);
    expect(r.allowed).toBe(true);
  });

  it('returns denied if any result is denied', () => {
    const r = mergeResults([allowResult(), denyResult(), allowResult()]);
    expect(r.allowed).toBe(false);
  });

  it('merges filterConditions from multiple results', () => {
    const r1 = filterResult([{ column: 'a', termType: 'eq', value: '1' }] as any);
    const r2 = filterResult([{ column: 'b', termType: 'eq', value: '2' }] as any);
    const merged = mergeResults([r1, r2]);
    expect(merged.allowed).toBe(true);
    expect(merged.filterConditions).toHaveLength(2);
  });

  it('merges denyFields as a union (deduped)', () => {
    const r1: DataAccessResult = { allowed: true, denyFields: ['a', 'b'] };
    const r2: DataAccessResult = { allowed: true, denyFields: ['b', 'c'] };
    const merged = mergeResults([r1, r2]);
    expect(merged.denyFields).toEqual(expect.arrayContaining(['a', 'b', 'c']));
    expect(merged.denyFields).toHaveLength(3);
  });

  it('returns undefined filterConditions when none present', () => {
    const merged = mergeResults([allowResult(), allowResult()]);
    expect(merged.filterConditions).toBeUndefined();
  });

  it('returns undefined denyFields when none present', () => {
    const merged = mergeResults([allowResult()]);
    expect(merged.denyFields).toBeUndefined();
  });

  it('handles mix of results with and without filter conditions', () => {
    const r1 = allowResult();
    const r2 = filterResult([{ column: 'x', termType: 'eq', value: '1' }] as any);
    const merged = mergeResults([r1, r2]);
    expect(merged.filterConditions).toHaveLength(1);
  });

  it('all allowed results produce an allowed merge', () => {
    const merged = mergeResults([allowResult(), allowResult(), allowResult()]);
    expect(merged.allowed).toBe(true);
  });
});
