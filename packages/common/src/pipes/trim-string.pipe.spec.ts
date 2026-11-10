import { describe, expect, it } from 'vitest';
import { TrimStringPipe } from './trim-string.pipe';

describe('TrimStringPipe', () => {
  const pipe = new TrimStringPipe();
  it('keeps arrays as arrays and trims nested strings', () => {
    expect(pipe.transform([{ name: ' a ' }, ' b '])).toEqual([{ name: 'a' }, 'b']);
    expect(pipe.transform({ tags: [' x '], nested: { v: ' y ' } })).toEqual({ tags: ['x'], nested: { v: 'y' } });
  });
  it('does not turn Dates or class instances into plain objects', () => {
    const when = new Date();
    const out = pipe.transform({ when }) as { when: Date };
    expect(out.when).toBe(when);
    expect(pipe.transform(when)).toBe(when);
  });
});
