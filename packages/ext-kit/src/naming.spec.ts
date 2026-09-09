import { describe, expect, it } from 'vitest';
import {
  buildBatchFileName,
  buildQuickFileName,
  folderNameFor,
  hostOf,
  normalizeUrls,
  sanitize,
  urlBaseName,
} from './naming';

describe('sanitize', () => {
  it('replaces filesystem-unsafe characters with dashes and collapses runs', () => {
    expect(sanitize('a/b:c*d?e"f<g>h|i#j&k=l%m')).toBe('a-b-c-d-e-f-g-h-i-j-k-l-m');
    expect(sanitize('--a--b--')).toBe('a-b');
    expect(sanitize('')).toBe('');
  });

  it('keeps unicode readable', () => {
    expect(sanitize('例子.com/关于我们')).toBe('例子.com-关于我们');
  });
});

describe('hostOf', () => {
  it('extracts host and falls back to input', () => {
    expect(hostOf('https://a.example.com/x?y=1')).toBe('a.example.com');
    expect(hostOf('not a url')).toBe('not a url');
  });
});

describe('normalizeUrls', () => {
  it('keeps only http(s), strips hash, dedupes, caps at 500', () => {
    const input = [
      'https://a.com/x#frag',
      'https://a.com/x',
      'ftp://a.com/x',
      'javascript:alert(1)',
      ' https://b.com ',
      42,
      null,
    ];
    expect(normalizeUrls(input)).toEqual(['https://a.com/x', 'https://b.com/']);
    const many = Array.from({ length: 600 }, (_, i) => `https://x.com/${i}`);
    expect(normalizeUrls(many)).toHaveLength(500);
  });
});

describe('urlBaseName', () => {
  it('uses host + path + query, strips www and trailing slashes', () => {
    expect(urlBaseName('https://www.example.com/pricing', 120, true)).toBe('example.com-pricing');
    expect(urlBaseName('https://example.com/list?page=2&sort=price', 120, true)).toBe(
      'example.com-list-page-2-sort-price',
    );
  });

  it('can exclude query (quick capture names)', () => {
    expect(urlBaseName('https://example.com/list?page=2', 110, false)).toBe('example.com-list');
  });

  it('decodes unicode paths', () => {
    expect(urlBaseName('https://example.com/%E5%85%B3%E4%BA%8E', 120, true)).toBe(
      'example.com-关于',
    );
  });

  it('falls back to "page" for garbage', () => {
    expect(urlBaseName('%%%', 120, true)).toBe('page');
  });
});

describe('buildBatchFileName', () => {
  it('prefixes zero-padded index inside the batch folder', () => {
    expect(
      buildBatchFileName('ExampleCapture/acme.com-20260101-0900', { url: 'https://acme.com/a', index: 7 }, 'png'),
    ).toBe('ExampleCapture/acme.com-20260101-0900/007_acme.com-a.png');
  });
});

describe('buildQuickFileName', () => {
  it('places quick files under the brand quick folder with a timestamp', () => {
    const name = buildQuickFileName('ExampleExport', 'Quick Converts', 'https://acme.com/report', 'pdf');
    expect(name).toMatch(/^ExampleExport\/Quick Converts\/acme\.com-report-\d{8}-\d{6}\.pdf$/);
  });
});

describe('folderNameFor', () => {
  it('prefixes the shared host when all urls share one domain', () => {
    const folder = folderNameFor(['https://www.acme.com/', 'https://acme.com/pricing']);
    expect(folder).toMatch(/^acme\.com-\d{8}-\d{4}$/);
  });

  it('uses timestamp only for mixed domains', () => {
    const folder = folderNameFor(['https://acme.com/', 'https://other.com/']);
    expect(folder).toMatch(/^\d{8}-\d{4}$/);
  });
});
