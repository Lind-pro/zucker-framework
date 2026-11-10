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
    expect(() => validateSiteDocument({ ...input(), version: 3 })).toThrow();
    expect(() => validateSiteDocument({ ...input(), version: '2' })).toThrow();
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
  it('upgrades version 1 in memory without rewriting other fields', () => {
    const v1 = input();
    const result = validateSiteDocument(v1);
    expect(result.version).toBe(2);
    expect(result.blocks).toEqual(v1.blocks);
    expect(validateSiteDocument(result)).toEqual(result);
  });
  it('keeps version 1 limited to version 1 block types and fields', () => {
    const stats = { id: 'numbers', type: 'stats', heading: 'Numbers', items: [] };
    expect(() => validateSiteDocument({ ...input(), blocks: [stats] })).toThrow(
      'Unsupported site block',
    );
    expect(validateSiteDocument({ ...input(), version: 2, blocks: [stats] }).blocks[0]).toEqual({
      ...stats,
      enabled: true,
      text: '',
    });
    const hero = { ...input().blocks[0], variant: 'split' };
    expect(() => validateSiteDocument({ ...input(), blocks: [hero] })).toThrow('Unexpected field');
    expect(
      validateSiteDocument({ ...input(), version: 2, blocks: [hero] }).blocks[0],
    ).toMatchObject({ variant: 'split' });
  });
  it('validates version 2 landing blocks, defaults and unsafe links', () => {
    const doc = (block: Record<string, unknown>) => ({ ...input(), version: 2, blocks: [block] });
    const pricing = { id: 'pricing', type: 'pricing', heading: 'Plans', plans: ['pro', 'team'] };
    expect(validateSiteDocument(doc(pricing)).blocks[0]).toMatchObject({
      plans: ['pro', 'team'],
      showCreditPacks: false,
    });
    expect(validateSiteDocument(doc({ ...pricing, plans: 'all' })).blocks[0]).toMatchObject({
      plans: 'all',
    });
    for (const plans of [[], ['Pro'], ['pro', 'pro'], 'some'])
      expect(() => validateSiteDocument(doc({ ...pricing, plans }))).toThrow();
    expect(() => validateSiteDocument(doc({ ...pricing, price: 10 }))).toThrow('Unexpected field');
    const newsletter = {
      id: 'news',
      type: 'newsletter',
      heading: 'News',
      formAction: '/api/newsletter',
      emailLabel: 'Email',
      buttonLabel: 'Subscribe',
    };
    expect(validateSiteDocument(doc(newsletter)).blocks[0]).toMatchObject({
      formAction: '/api/newsletter',
    });
    for (const formAction of [
      'http://x.test/a',
      'relative',
      '#x',
      'javascript:alert(1)',
      '//x.test',
    ])
      expect(() => validateSiteDocument(doc({ ...newsletter, formAction }))).toThrow();
    expect(
      validateSiteDocument(doc({ id: 'blog', type: 'blog-list', heading: 'Blog' })).blocks[0],
    ).toMatchObject({ limit: 3 });
    expect(() =>
      validateSiteDocument(doc({ id: 'blog', type: 'blog-list', heading: 'Blog', limit: 13 })),
    ).toThrow();
    const media = { id: 'video', type: 'media', kind: 'video', src: '/demo.mp4', alt: 'Demo' };
    expect(validateSiteDocument(doc(media)).blocks[0]).toMatchObject({ heading: '', caption: '' });
    expect(() => validateSiteDocument(doc({ ...media, src: 'data:video/mp4,x' }))).toThrow();
    expect(() => validateSiteDocument(doc({ ...media, alt: '' }))).toThrow();
    const logos = {
      id: 'logos',
      type: 'logo-cloud',
      items: [{ name: 'Acme', image: { src: 'javascript:x', alt: '' } }],
    };
    try {
      validateSiteDocument(doc(logos));
      throw new Error('expected failure');
    } catch (error) {
      expect((error as { field: string }).field).toBe('blocks.0.items.0.image.src');
    }
  });
});
