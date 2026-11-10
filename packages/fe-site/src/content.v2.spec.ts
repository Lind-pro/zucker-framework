import { describe, expect, it } from 'vitest';
import {
  SITE_BLOCK_TYPES,
  SITE_BLOCK_TYPES_V1,
  SITE_CONTENT_LIMITS as L,
  SiteContentValidationError,
  safeSiteFormAction,
  safeSiteHref,
  siteDocumentText,
  validateSiteDocument,
  visibleSiteDocument,
} from './content';

const doc = (blocks: unknown[], version: 1 | 2 = 2, extra: Record<string, unknown> = {}) => ({
  version,
  title: 'T',
  blocks,
  ...extra,
});
const img = { src: '/a.png', alt: 'A' };
const fieldOf = (value: unknown): string => {
  try {
    validateSiteDocument(value);
  } catch (error) {
    expect(error).toBeInstanceOf(SiteContentValidationError);
    return (error as SiteContentValidationError).field;
  }
  throw new Error('expected validation failure');
};

/** One minimal valid block per type, with a known-bad variant producing the expected field path. */
const valid: Record<string, Record<string, unknown>> = {
  hero: { heading: 'H', text: 'x' },
  markdown: { markdown: '# x' },
  features: { heading: 'H', items: [{ title: 'a', text: 'b' }] },
  faq: { heading: 'H', items: [{ question: 'q', answer: 'a' }] },
  cta: { heading: 'H', action: { label: 'go', href: '/x' } },
  links: { heading: 'H', items: [{ label: 'l', href: '/x' }] },
  'logo-cloud': { items: [{ name: 'Acme', image: img }] },
  stats: { heading: 'H', items: [{ value: '1', label: 'l' }] },
  steps: { heading: 'H', items: [{ title: 't', text: 'x' }] },
  testimonials: { heading: 'H', items: [{ quote: 'q', author: 'a' }] },
  showcase: { heading: 'H', items: [{ title: 't', image: img }] },
  pricing: { heading: 'H', plans: 'all' },
  newsletter: { heading: 'H', formAction: '/n', emailLabel: 'e', buttonLabel: 'b' },
  'blog-list': { heading: 'H' },
  changelog: { heading: 'H' },
  media: { kind: 'image', src: '/m.png', alt: 'm' },
};
const make = (type: string, extra: Record<string, unknown> = {}) => ({
  id: 'b1',
  type,
  ...valid[type],
  ...extra,
});

describe('site document v2 schema', () => {
  it('lists every block type with a fixture and accepts each minimal block', () => {
    expect(Object.keys(valid).sort()).toEqual([...SITE_BLOCK_TYPES].sort());
    expect(SITE_BLOCK_TYPES.slice(0, 6)).toEqual([...SITE_BLOCK_TYPES_V1]);
    for (const type of SITE_BLOCK_TYPES) {
      const out = validateSiteDocument(doc([make(type)]));
      expect(out.blocks[0]).toMatchObject({ type, enabled: true });
    }
  });

  it.each(Object.keys(valid))('%s rejects unknown fields and bad ids with field paths', (type) => {
    expect(fieldOf(doc([make(type, { surprise: 1 })]))).toBe('blocks.0');
    expect(fieldOf(doc([make(type, { id: 'Bad Id' })]))).toBe('blocks.0.id');
    expect(fieldOf(doc([make(type, { enabled: 'yes' })]))).toBe('blocks.0.enabled');
  });

  it('requires headings except markdown, logo-cloud and media', () => {
    for (const type of SITE_BLOCK_TYPES) {
      const block = make(type, { heading: '' });
      const optional = ['markdown', 'logo-cloud', 'media'].includes(type);
      if (optional) expect(() => validateSiteDocument(doc([block]))).not.toThrow();
      else expect(fieldOf(doc([block]))).toBe('blocks.0.heading');
    }
  });

  it('hero and features variants, image and secondaryAction', () => {
    const hero = validateSiteDocument(
      doc([make('hero', { variant: 'split', image: img, secondaryAction: { label: 'l', href: '/s' } })]),
    ).blocks[0];
    expect(hero).toMatchObject({ variant: 'split', image: img, secondaryAction: { href: '/s' } });
    expect(fieldOf(doc([make('hero', { variant: 'wide' })]))).toBe('blocks.0.variant');
    expect(fieldOf(doc([make('features', { variant: 'masonry' })]))).toBe('blocks.0.variant');
    expect(fieldOf(doc([make('hero', { secondaryAction: { label: 'x', href: 'javascript:1' } })]))).toBe(
      'blocks.0.secondaryAction.href',
    );
    expect(fieldOf(doc([make('hero', { image: { src: 'data:image/png;base64,AA', alt: '' } })]))).toBe(
      'blocks.0.image.src',
    );
    expect(fieldOf(doc([make('hero', { image: { ...img, width: 0 } })]))).toBe('blocks.0.image.width');
    expect(fieldOf(doc([make('hero', { image: { ...img, height: L.imageDimension + 1 } })]))).toBe(
      'blocks.0.image.height',
    );
  });

  it('applies defaults', () => {
    const out = validateSiteDocument(doc([make('blog-list'), make('changelog', { id: 'c' }), make('pricing', { id: 'p' })]));
    expect(out.blocks[0]).toMatchObject({ limit: 3, text: '' });
    expect(out.blocks[1]).toMatchObject({ limit: 5 });
    expect(out.blocks[2]).toMatchObject({ showCreditPacks: false, plans: 'all' });
    expect(out.blocks[0]).not.toHaveProperty('category');
  });

  it('enforces numeric and list limits with field paths', () => {
    expect(fieldOf(doc([make('blog-list', { limit: 0 })]))).toBe('blocks.0.limit');
    expect(fieldOf(doc([make('blog-list', { limit: 1.5 })]))).toBe('blocks.0.limit');
    expect(fieldOf(doc([make('blog-list', { limit: '3' })]))).toBe('blocks.0.limit');
    expect(() => validateSiteDocument(doc([make('blog-list', { limit: L.blogListLimit })]))).not.toThrow();
    expect(fieldOf(doc([make('blog-list', { limit: L.blogListLimit + 1 })]))).toBe('blocks.0.limit');
    expect(fieldOf(doc([make('changelog', { limit: L.changelogLimit + 1 })]))).toBe('blocks.0.limit');
    expect(fieldOf(doc([make('blog-list', { category: 'Has Space' })]))).toBe('blocks.0.category');
    const many = (n: number) => Array.from({ length: n }, () => ({ value: '1', label: 'l' }));
    expect(() => validateSiteDocument(doc([make('stats', { items: many(L.statItems) })]))).not.toThrow();
    expect(fieldOf(doc([make('stats', { items: many(L.statItems + 1) })]))).toBe('blocks.0.items');
    expect(fieldOf(doc([make('stats', { items: [{ value: 'x'.repeat(33), label: 'l' }] })]))).toBe(
      'blocks.0.items.0.value',
    );
    const logos = Array.from({ length: L.logoItems + 1 }, (_, i) => ({ name: `n${i}`, image: img }));
    expect(fieldOf(doc([make('logo-cloud', { items: logos })]))).toBe('blocks.0.items');
    expect(fieldOf(doc([make('pricing', { plans: Array.from({ length: 13 }, (_, i) => `p${i}`) })]))).toBe(
      'blocks.0.plans',
    );
    expect(() =>
      validateSiteDocument(doc([make('pricing', { plans: Array.from({ length: 12 }, (_, i) => `p${i}`) })])),
    ).not.toThrow();
  });

  it('block count: v1 max 20, v2 max 32', () => {
    const blocks = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ id: `b${i}`, type: 'cta', heading: 'H', action: { label: 'a', href: '/x' } }));
    expect(() => validateSiteDocument(doc(blocks(20), 1))).not.toThrow();
    expect(fieldOf(doc(blocks(21), 1))).toBe('blocks');
    expect(() => validateSiteDocument(doc(blocks(32), 2))).not.toThrow();
    expect(fieldOf(doc(blocks(33), 2))).toBe('blocks');
  });

  it('pricing carries slugs only, never prices', () => {
    for (const k of ['price', 'prices', 'currency', 'credits', 'amount'])
      expect(fieldOf(doc([make('pricing', { [k]: 1 })]))).toBe('blocks.0');
    expect(fieldOf(doc([make('pricing', { plans: ['ok', 'ok'] })]))).toBe('blocks.0.plans');
    expect(fieldOf(doc([make('pricing', { plans: [] })]))).toBe('blocks.0.plans');
    expect(fieldOf(doc([make('pricing', { plans: ['Up'] })]))).toBe('blocks.0.plans.0');
    expect(fieldOf(doc([make('pricing', { plans: 'ALL' })]))).toBe('blocks.0.plans');
    expect(fieldOf(doc([make('pricing', { showCreditPacks: 'true' })]))).toBe('blocks.0.showCreditPacks');
  });

  it('media: alt required, kind enum, poster/src must be safe', () => {
    expect(fieldOf(doc([make('media', { alt: '   ' })]))).toBe('blocks.0.alt');
    expect(fieldOf(doc([make('media', { kind: 'audio' })]))).toBe('blocks.0.kind');
    expect(fieldOf(doc([make('media', { poster: 'javascript:x' })]))).toBe('blocks.0.poster');
    expect(fieldOf(doc([make('media', { src: '//cdn.test/x.mp4' })]))).toBe('blocks.0.src');
    expect(fieldOf(doc([make('media', { width: -1 })]))).toBe('blocks.0.width');
    expect(validateSiteDocument(doc([make('media', { kind: 'video', poster: '/p.png', width: 640, height: 360 })])).blocks[0]).toMatchObject({
      poster: '/p.png',
      width: 640,
      height: 360,
    });
  });

  it('nested field paths for items', () => {
    expect(fieldOf(doc([make('testimonials', { items: [{ quote: 'q', author: 'a', avatar: { src: 'javascript:1', alt: '' } }] })]))).toBe(
      'blocks.0.items.0.avatar.src',
    );
    expect(fieldOf(doc([make('showcase', { items: [{ title: 't', image: img, href: 'data:x' }] })]))).toBe(
      'blocks.0.items.0.href',
    );
    expect(fieldOf(doc([make('logo-cloud', { items: [{ name: 'a', image: img, href: '//x.test' }] })]))).toBe(
      'blocks.0.items.0.href',
    );
    expect(fieldOf(doc([make('steps', { items: [{ title: 't' }] })]))).toBe('blocks.0.items.0.text');
    expect(fieldOf(doc([make('features'), make('faq', { id: 'f', items: [{ question: 'q', answer: 'a' }, { question: '' , answer: 'a'}] })]))).toBe(
      'blocks.1.items.1.question',
    );
  });

  it('v1 documents reject every v2 type and v2-only field, and v2 fields stay v2-only', () => {
    for (const type of SITE_BLOCK_TYPES.slice(6))
      expect(['blocks.0', 'blocks.0.type']).toContain(fieldOf(doc([make(type)], 1)));
    for (const extra of [{ variant: 'split' }, { image: img }, { secondaryAction: { label: 'l', href: '/x' } }])
      expect(() => validateSiteDocument(doc([make('hero', extra)], 1))).toThrow('Unexpected field');
    expect(() => validateSiteDocument(doc([make('features', { variant: 'grid' })], 1))).toThrow('Unexpected field');
    const v1 = doc([make('hero')], 1);
    expect(validateSiteDocument(v1).version).toBe(2);
    expect(fieldOf({ ...v1, version: 3 })).toBe('version');
    expect(fieldOf({ ...v1, version: undefined })).toBe('version');
  });

  it('validation returns an independent snapshot and refuses an own __proto__ key', () => {
    const input = doc([make('hero')]);
    const out = validateSiteDocument(input);
    (input.blocks[0] as { heading: string }).heading = 'changed';
    expect(out.blocks[0]).toMatchObject({ heading: 'H' });
    const polluted = JSON.parse('{"id":"b1","type":"hero","heading":"H","__proto__":{"x":1}}');
    // JSON.parse creates an own "__proto__" key; it is not an allowed field, so it is refused.
    expect(() => validateSiteDocument(doc([polluted]))).toThrow('Unexpected field');
    expect(({} as { x?: number }).x).toBeUndefined();
  });

  it('rejects control characters and over-long text', () => {
    expect(fieldOf(doc([make('hero', { heading: 'a\u0000b' })]))).toBe('blocks.0.heading');
    expect(fieldOf(doc([make('hero', { heading: 'x'.repeat(201) })]))).toBe('blocks.0.heading');
    expect(fieldOf(doc([make('hero', { text: 'x'.repeat(4001) })]))).toBe('blocks.0.text');
  });

  it('safeSiteFormAction accepts https URLs and same-origin paths only', () => {
    for (const ok of ['/api/newsletter', 'https://mail.example.test/subscribe', '/a?b=1'])
      expect(safeSiteFormAction(ok)).toBe(ok);
    for (const bad of [
      'http://mail.example.test/x',
      '#frag',
      'relative/path',
      '//evil.test/x',
      '/\\evil.test',
      'javascript:alert(1)',
      'JAVASCRIPT:alert(1)',
      'data:text/html,x',
      'https://u:p@mail.test/x',
      ' /x',
      '',
      null,
      undefined,
      42,
    ])
      expect(safeSiteFormAction(bad), String(bad)).toBeNull();
  });

  it('siteDocumentText includes new enabled blocks and excludes disabled ones', () => {
    const out = validateSiteDocument(
      doc([
        make('hero', { id: 'h', text: 'hero-text', secondaryAction: { label: 'second-label', href: '/s' } }),
        make('logo-cloud', { id: 'l', items: [{ name: 'logo-name', image: img }] }),
        make('stats', { id: 's', text: 'stats-text', items: [{ value: 'stat-value', label: 'stat-label' }] }),
        make('steps', { id: 'st', text: 'steps-text', items: [{ title: 'step-title', text: 'step-body' }] }),
        make('testimonials', { id: 't', items: [{ quote: 'quote-text', author: 'author-name', role: 'role-text' }] }),
        make('showcase', { id: 'sh', text: 'showcase-text', items: [{ title: 'show-title', text: 'show-body', image: img }] }),
        make('pricing', { id: 'p', text: 'pricing-text' }),
        make('newsletter', { id: 'n', text: 'news-text' }),
        make('blog-list', { id: 'b', text: 'blog-text' }),
        make('changelog', { id: 'c', text: 'log-text' }),
        make('media', { id: 'm', alt: 'media-alt', caption: 'media-caption' }),
        make('stats', { id: 'off', enabled: false, heading: 'SECRET', items: [{ value: 'hidden-val', label: 'x' }] }),
      ]),
    );
    const text = siteDocumentText(out);
    for (const needle of ['hero-text', 'second-label', 'logo-name', 'stats-text', 'stat-value', 'stat-label', 'steps-text', 'step-title', 'step-body', 'quote-text', 'author-name', 'role-text', 'showcase-text', 'show-title', 'show-body', 'pricing-text', 'news-text', 'blog-text', 'log-text', 'media-alt', 'media-caption'])
      expect(text, needle).toContain(needle);
    expect(text).not.toContain('SECRET');
    expect(text).not.toContain('hidden-val');
    expect(visibleSiteDocument(out).blocks.some((b) => b.id === 'off')).toBe(false);
  });
});

/**
 * Security gate 7: content never executes. Every link-like field of every block type must refuse
 * executable and ambiguous targets at validation time.
 */
describe('security gate 7: content never executes (validation)', () => {
  const unsafe = [
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'vbscript:msgbox(1)',
    'data:text/html,<script>alert(1)</script>',
    'data:image/svg+xml;base64,PHN2Zz4=',
    'blob:https://x.test/uuid',
    'file:///etc/passwd',
    'ftp://x.test/a',
    '//attacker.invalid/path',
    '///attacker.invalid',
    '\\\\attacker.invalid',
    '/\\attacker.invalid',
    'https:\\\\attacker.invalid',
    ' javascript:alert(1)',
    'java\nscript:alert(1)',
    'java\tscript:alert(1)',
    'java\u0000script:alert(1)',
    '\u0001javascript:alert(1)',
    'javascript&colon;alert(1)'.replace('&colon;', ':'),
    'https://user:pw@example.test/',
    'https://user@example.test/',
    '/ok\u007f',
    `/${'a'.repeat(2048)}`,
  ];
  const slots: Array<[string, (href: string) => unknown]> = [
    ['hero.action', (href) => make('hero', { action: { label: 'l', href } })],
    ['hero.secondaryAction', (href) => make('hero', { secondaryAction: { label: 'l', href } })],
    ['hero.image', (href) => make('hero', { image: { src: href, alt: '' } })],
    ['features.image', (href) => make('features', { image: { src: href, alt: '' } })],
    ['cta', (href) => make('cta', { action: { label: 'l', href } })],
    ['links', (href) => make('links', { items: [{ label: 'l', href }] })],
    ['logo.image', (href) => make('logo-cloud', { items: [{ name: 'n', image: { src: href, alt: '' } }] })],
    ['logo.href', (href) => make('logo-cloud', { items: [{ name: 'n', image: img, href }] })],
    ['testimonial.avatar', (href) => make('testimonials', { items: [{ quote: 'q', author: 'a', avatar: { src: href, alt: '' } }] })],
    ['showcase.image', (href) => make('showcase', { items: [{ title: 't', image: { src: href, alt: '' } }] })],
    ['showcase.href', (href) => make('showcase', { items: [{ title: 't', image: img, href }] })],
    ['newsletter', (href) => make('newsletter', { formAction: href })],
    ['media.src', (href) => make('media', { src: href })],
    ['media.poster', (href) => make('media', { poster: href })],
  ];
  for (const [name, build] of slots)
    it(`${name} refuses unsafe targets`, () => {
      for (const href of unsafe) {
        expect(() => validateSiteDocument(doc([build(href)])), `${name}: ${href.slice(0, 40)}`).toThrow(
          SiteContentValidationError,
        );
      }
    });

  it('safeSiteHref refuses every unsafe sample and unusual types', () => {
    for (const href of unsafe) expect(safeSiteHref(href), href.slice(0, 40)).toBeNull();
    for (const bad of [null, undefined, 1, {}, [], ['https://x.test'], '']) expect(safeSiteHref(bad)).toBeNull();
  });

  it('percent-encoded or entity-encoded schemes are never turned into an executable scheme', () => {
    // These stay inert relative paths: a browser does not decode %xx or HTML entities in the scheme.
    for (const href of ['java%73cript:alert(1)', '%6Aavascript:alert(1)', '&#106;avascript:alert(1)', 'javascript%3Aalert(1)'])
      expect(safeSiteHref(href)).toBe(href);
    for (const href of ['java%73cript:alert(1)', '&#106;avascript:alert(1)'])
      expect(new URL(href, 'https://site.invalid').protocol).toBe('https:');
  });

  it('allows legitimate navigation', () => {
    for (const ok of ['/a', '/a?b=c#d', '#x', 'rel/path', 'https://example.test/a', 'http://example.test'])
      expect(safeSiteHref(ok)).toBe(ok);
  });

  it('has no HTML, component, script, style or event-handler fields on any block', () => {
    for (const type of SITE_BLOCK_TYPES)
      for (const key of ['html', 'innerHTML', 'dangerouslySetInnerHTML', 'component', 'script', 'style', 'className', 'onClick', 'code', 'css'])
        expect(() => validateSiteDocument(doc([make(type, { [key]: 'x' })])), `${type}.${key}`).toThrow('Unexpected field');
    expect(() => validateSiteDocument(doc([make('hero')], 2, { html: '<b>x</b>' }))).toThrow('Unexpected field');
  });

  it('markdown and text fields stay plain strings: HTML is data, not structure', () => {
    const out = validateSiteDocument(doc([make('hero', { heading: '<img src=x onerror=alert(1)>' }), make('markdown', { id: 'm', markdown: '<script>x()</script>' })]));
    expect(out.blocks[0]).toMatchObject({ heading: '<img src=x onerror=alert(1)>' });
    expect(fieldOf(doc([make('markdown', { markdown: { html: 'x' } })]))).toBe('blocks.0.markdown');
  });

  it('rejects accessor and non-plain objects (no code runs during validation)', () => {
    let ran = false;
    const block = { ...make('hero') };
    Object.defineProperty(block, 'heading', { enumerable: true, get() { ran = true; return 'x'; } });
    expect(() => validateSiteDocument(doc([block]))).toThrow('Unexpected field');
    expect(ran).toBe(false);
    class Evil { id = 'b1'; type = 'hero'; heading = 'H'; }
    expect(() => validateSiteDocument(doc([new Evil()]))).toThrow('Expected a plain object');
    const proxy = new Proxy({}, { ownKeys() { ran = true; return []; } });
    try { validateSiteDocument(doc([proxy])); } catch { /* ok */ }
  });
});
