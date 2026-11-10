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
    '/\t/evil.com',
    '/\u0000/evil.com',
    '/\u001f/evil.com',
    '/\u007f/evil.com',
    '/\t\t//evil.com',
    '',
    'dashboard',
  ])('rejects an unsafe redirect: %s', (path) => {
    expect(isSafeRelativeRedirect(path)).toBe(false);
  });

  it('rejects a tab-prefixed path that a URL parser resolves to another origin', () => {
    expect(new URL('/\t/evil.com', 'https://app.example').origin).toBe('https://evil.com');
    expect(isSafeRelativeRedirect(decodeURIComponent('/%09/evil.com'))).toBe(false);
  });
});
