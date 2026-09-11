import { describe, expect, it } from 'vitest';
import { isSafeRelativeRedirect } from './redirect';

describe('relative authentication redirects', () => {
  it.each(['/dashboard', '/fr/dashboard?view=recent#top', '/'])(
    'accepts a local path: %s',
    (path) => {
      expect(isSafeRelativeRedirect(path)).toBe(true);
    },
  );

  it.each([
    'https://example.test',
    '//example.test',
    '/\\example.test',
    '/a\nLocation: example.test',
    '/a\rLocation: example.test',
    '',
    'dashboard',
  ])('rejects an unsafe redirect: %s', (path) => {
    expect(isSafeRelativeRedirect(path)).toBe(false);
  });
});
