import { describe, expect, it } from 'vitest';
import {
  hasVisibleSiteContent,
  resolveSiteColorMode,
  resolveSiteTheme,
  safeSiteHref,
  siteDocumentText,
  validateSiteDocument,
  visibleSiteDocument,
} from './content';

const input = () => ({
  version: 1,
  title: 'Guide',
  markdown: '',
  blocks: [
    {
      id: 'public',
      type: 'hero',
      enabled: true,
      heading: 'Visible guide',
      text: 'Published text',
      action: { label: 'Read', href: '/docs/start' },
    },
    {
      id: 'private',
      type: 'hero',
      enabled: false,
      heading: 'Unannounced launch',
      text: 'Private draft text',
    },
  ],
});
describe('versioned public site document contract', () => {
  it('projects enabled blocks into independent publication and search snapshots', () => {
    const draft = validateSiteDocument(input()),
      published = visibleSiteDocument(draft);
    expect(published.blocks.map((block) => block.id)).toEqual(['public']);
    expect(siteDocumentText(draft)).toContain('Published text');
    expect(siteDocumentText(draft)).not.toContain('Private draft');
    draft.blocks[0].heading = 'Later draft change';
    expect(published.blocks[0].heading).toBe('Visible guide');
    expect(
      hasVisibleSiteContent({ ...draft, blocks: draft.blocks.filter((block) => !block.enabled) }),
    ).toBe(false);
  });
  it.each([
    'javascript:alert(1)',
    'data:text/html,x',
    '//attacker.invalid',
    'https://user:password@example.test',
    'https:\\evil.test',
    '/bad\nlink',
    ' /space',
    'file:///tmp/x',
  ])('rejects unsafe action link %s', (href) => {
    expect(safeSiteHref(href)).toBeNull();
    const value = input();
    value.blocks[0].action!.href = href;
    expect(() => validateSiteDocument(value)).toThrow();
  });
  it('accepts controlled navigation and rejects unknown executable block fields', () => {
    for (const href of ['/docs/start', '#section', 'relative-page', 'https://example.test/a'])
      expect(safeSiteHref(href)).toBe(href);
    expect(() => validateSiteDocument({ ...input(), component: 'ArbitraryComponent' })).toThrow();
    expect(() =>
      validateSiteDocument({ ...input(), blocks: [{ ...input().blocks[0], code: 'execute()' }] }),
    ).toThrow();
    expect(() =>
      validateSiteDocument({ ...input(), blocks: [{ ...input().blocks[0], type: 'script' }] }),
    ).toThrow();
    expect(() =>
      validateSiteDocument({ ...input(), blocks: [input().blocks[0], input().blocks[0]] }),
    ).toThrow();
  });
  it('bounds UTF-8 payload size, versions, lists and non-JSON objects', () => {
    expect(() => validateSiteDocument({ ...input(), markdown: '界'.repeat(23000) })).toThrow(
      /64 KiB/,
    );
    expect(() => validateSiteDocument({ ...input(), version: 2 })).toThrow();
    expect(() => validateSiteDocument({ ...input(), blocks: new Array(1) })).toThrow();
    expect(() =>
      validateSiteDocument({
        ...input(),
        blocks: Array.from({ length: 21 }, (_, i) => ({ ...input().blocks[0], id: `block-${i}` })),
      }),
    ).toThrow();
    const getter = Object.defineProperty(input(), 'title', {
      get() {
        throw new Error('must not execute');
      },
      enumerable: true,
    });
    expect(() => validateSiteDocument(getter)).toThrow('Unexpected field');
  });
  it('resolves named themes only from explicit consumer registries', () => {
    expect(resolveSiteTheme('editorial', ['default', 'editorial'])).toEqual({
      name: 'editorial',
      usedFallback: false,
    });
    expect(resolveSiteTheme('../private', ['default'])).toEqual({
      name: 'default',
      usedFallback: true,
    });
    expect(() => resolveSiteTheme('x', ['editorial'])).toThrow();
    expect(resolveSiteColorMode('system')).toBe('system');
    expect(resolveSiteColorMode('unknown')).toBe('dark');
  });
});
