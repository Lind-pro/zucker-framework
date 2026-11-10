import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { SiteBlock } from '@zucker-framework/fe-site/content';
import { BlockRenderer, defineTheme } from './index';
import type { BlockRenderIssue, BlockSlots } from './index';

/**
 * Security gate 7 at render time. Blocks are handed to the renderer WITHOUT validation, as if a
 * stale or hand-edited snapshot bypassed `validateSiteDocument`: the renderer must still refuse
 * unsafe targets and never emit raw HTML.
 */
const UNSAFE = [
  'javascript:alert(1)',
  'JaVaScRiPt:alert(1)',
  'data:text/html,<script>alert(1)</script>',
  'data:image/svg+xml;base64,PHN2Zz4=',
  'vbscript:x',
  'blob:https://x.test/u',
  '//attacker.invalid/x',
  '/\\attacker.invalid',
  'java\nscript:alert(1)',
  ' javascript:alert(1)',
  'https://user:pw@example.test/',
];
const img = (src: string) => ({ src, alt: 'x' });
const render = (
  blocks: unknown[],
  slots: BlockSlots = {},
  issues: BlockRenderIssue[] = [],
  markdown = '',
) =>
  renderToStaticMarkup(
    <BlockRenderer
      document={{ markdown, blocks: blocks as SiteBlock[] }}
      locale="en"
      slots={slots}
      onIssue={(i) => issues.push(i)}
    />,
  );
const b = (type: string, extra: Record<string, unknown>) => ({
  id: 'b1',
  type,
  enabled: true,
  heading: 'H',
  text: '',
  ...extra,
});

describe('renderer refuses unsafe targets even without validation', () => {
  const cases: Array<[string, (v: string) => unknown, RegExp]> = [
    ['hero action', (v) => b('hero', { action: { label: 'L', href: v } }), /<a /],
    ['hero secondary', (v) => b('hero', { secondaryAction: { label: 'L', href: v } }), /<a /],
    ['hero image', (v) => b('hero', { image: img(v) }), /<img/],
    ['cta', (v) => b('cta', { action: { label: 'L', href: v } }), /<a /],
    ['links', (v) => b('links', { items: [{ label: 'L', href: v }] }), /<a /],
    ['logo href', (v) => b('logo-cloud', { items: [{ name: 'N', image: img('/ok.png'), href: v }] }), /<a /],
    ['logo image', (v) => b('logo-cloud', { items: [{ name: 'N', image: img(v) }] }), /<img/],
    ['showcase href', (v) => b('showcase', { items: [{ title: 'T', text: '', image: img('/ok.png'), href: v }] }), /<a /],
    ['showcase image', (v) => b('showcase', { items: [{ title: 'T', text: '', image: img(v) }] }), /<img/],
    ['avatar', (v) => b('testimonials', { items: [{ quote: 'Q', author: 'A', role: '', avatar: img(v) }] }), /<img/],
    ['media image', (v) => b('media', { kind: 'image', src: v, alt: 'a', caption: '' }), /<img|<figure/],
    ['media video', (v) => b('media', { kind: 'video', src: v, alt: 'a', caption: '' }), /<video|<figure/],
  ];
  for (const [name, build, tag] of cases)
    it(name, () => {
      for (const value of UNSAFE) {
        const issues: BlockRenderIssue[] = [];
        const html = render([build(value)], {}, issues);
        expect(html, `${name}: ${value}`).not.toMatch(tag);
        expect(html.toLowerCase()).not.toContain('javascript:');
        expect(html.toLowerCase()).not.toContain('data:');
        expect(html).not.toContain('attacker.invalid');
        expect(html).not.toContain('user:pw');
        expect(issues.some((i) => i.code === 'unsafe-href'), `${name}: ${value}`).toBe(true);
      }
    });

  it('media poster is dropped when unsafe but a safe video still renders', () => {
    const issues: BlockRenderIssue[] = [];
    const html = render([b('media', { kind: 'video', src: '/v.mp4', alt: 'a', caption: '', poster: 'javascript:x' })], {}, issues);
    expect(html).toContain('<video');
    expect(html).not.toContain('poster=');
    expect(issues).toContainEqual(expect.objectContaining({ code: 'unsafe-href', field: 'poster' }));
  });

  it('newsletter with an unsafe formAction renders no form', () => {
    for (const formAction of ['javascript:alert(1)', 'http://x.test/a', '//x.test', '#x', 'rel', 'data:text/html,x']) {
      const issues: BlockRenderIssue[] = [];
      const html = render([b('newsletter', { formAction, emailLabel: 'E', buttonLabel: 'B' })], {}, issues);
      expect(html, formAction).not.toContain('<form');
      expect(issues).toContainEqual(expect.objectContaining({ code: 'unsafe-href', field: 'formAction' }));
    }
  });

  it('resolveHref returning an unsafe URL drops the link; returning a safe one maps it', () => {
    for (const bad of UNSAFE) {
      const issues: BlockRenderIssue[] = [];
      const html = render(
        [b('cta', { action: { label: 'L', href: '/ok' } }), { ...b('links', { items: [{ label: 'K', href: '/k' }] }), id: 'b2' }],
        { resolveHref: () => bad },
        issues,
      );
      expect(html).not.toContain('<a ');
      expect(html.toLowerCase()).not.toContain('javascript:');
      expect(issues.filter((i) => i.code === 'unsafe-href')).toHaveLength(2);
    }
    const html = render([b('cta', { action: { label: 'L', href: '/ok' } })], { resolveHref: (h, l) => `/${l}${h}` });
    expect(html).toContain('href="/en/ok"');
  });

  it('resolveHref is not consulted for unsafe input and never for image sources', () => {
    const calls: string[] = [];
    render([b('cta', { action: { label: 'L', href: 'javascript:alert(1)' } })], { resolveHref: (h) => (calls.push(h), h) });
    expect(calls).toEqual([]);
    const html = render([b('media', { kind: 'image', src: '/i.png', alt: 'a', caption: '' })], { resolveHref: (h) => (calls.push(h), '/mapped.png') });
    expect(calls).toEqual([]);
    expect(html).toContain('src="/i.png"');
  });
});

describe('renderer never emits raw HTML', () => {
  const payload = '<img src=x onerror=alert(1)><script>alert(1)</script>';
  it('escapes HTML in every text field', () => {
    const blocks = [
      b('hero', { id: 'a1', heading: payload, text: payload, action: { label: payload, href: '/x' } }),
      b('features', { id: 'a2', heading: payload, items: [{ title: payload, text: payload }] }),
      b('faq', { id: 'a3', heading: payload, items: [{ question: payload, answer: payload }] }),
      b('stats', { id: 'a4', heading: payload, items: [{ value: payload, label: payload }] }),
      b('testimonials', { id: 'a5', heading: payload, items: [{ quote: payload, author: payload, role: payload }] }),
      b('media', { id: 'a6', kind: 'image', src: '/i.png', alt: payload, caption: payload }),
      b('newsletter', { id: 'a7', formAction: '/n', emailLabel: payload, buttonLabel: payload }),
    ];
    const html = render(blocks, {}, [], payload);
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;');
    const dom = new DOMParser().parseFromString(html, 'text/html');
    expect(dom.querySelectorAll('script').length).toBe(0);
    for (const el of Array.from(dom.querySelectorAll('*')))
      expect(el.getAttributeNames().filter((n) => n.startsWith('on')), el.tagName).toEqual([]);
  });

  it('block ids and unknown extra fields cannot inject attributes or markup', () => {
    const html = render([{ ...b('hero', { onClick: 'x()', style: 'x', dangerouslySetInnerHTML: { __html: '<i>boom</i>' } }), id: 'evil" onmouseover="alert(1)' }]);
    expect(html).not.toContain('<i>boom</i>');
    expect(html).not.toMatch(/onmouseover="alert/);
    expect(html).not.toContain('onClick');
  });

  it('default theme source never uses dangerouslySetInnerHTML or javascript: literals', async () => {
    const { readFileSync, readdirSync } = await import('node:fs');
    const dir = `${process.cwd()}/packages/fe-blocks/src`;
    for (const f of readdirSync(dir).filter((n) => /\.tsx?$/.test(n) && !n.includes('.spec.'))) {
      const code = readFileSync(`${dir}/${f}`, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      expect(code, f).not.toMatch(/dangerouslySetInnerHTML|innerHTML|eval\(|new Function/);
    }
  });

  it('markdown without a slot is plain text; with a slot only the host output is rendered', () => {
    const html = render([], {}, [], '# hi <script>alert(1)</script>');
    expect(html).not.toContain('<script');
    expect(html).toContain('&lt;script&gt;');
  });

  it('theme tokens cannot break out of the style attribute', () => {
    for (const bad of ['red; background:url(javascript:1)', 'a}b', '<x>', 'a\\b', 'a\nb', 'x'.repeat(201), ''])
      expect(() => defineTheme({ name: 'x', tokens: { '--zb-bg': bad } }), bad).toThrow();
    for (const name of ['bg', '--Bad', 'color:red', '--a b'])
      expect(() => defineTheme({ name: 'x', tokens: { [name]: 'red' } }), name).toThrow();
    expect(() => defineTheme({ name: 'x', blocks: { hero: 'not a function' as never } })).toThrow();
    for (const name of ['', 'Upper', '1x', 'a b', '../x', 'x'.repeat(65)]) expect(() => defineTheme({ name })).toThrow();
  });
});

describe('renderer behaviour per variant and structure', () => {
  const base = (extra: Record<string, unknown>) => b('hero', { text: 'T', ...extra });
  it('hero variants and heading level', () => {
    const doc = (variant: string, level?: 1 | 2) =>
      renderToStaticMarkup(
        <BlockRenderer document={{ markdown: '', blocks: [base({ variant, image: img('/h.png') }) as SiteBlock] }} locale="en" heroHeadingLevel={level} />,
      );
    expect(doc('centered')).toContain('<h2');
    expect(doc('split', 1)).toContain('<h1');
    expect(doc('split')).not.toBe(doc('centered'));
    expect(doc('split')).toContain('src="/h.png"');
  });
  it('features list vs grid differ and sections carry id and data-block-type', () => {
    const f = (variant: string) =>
      render([b('features', { variant, items: [{ title: 'A', text: 'B' }] })]);
    expect(f('list')).not.toBe(f('grid'));
    expect(f('grid')).toContain('id="b1"');
    expect(f('grid')).toContain('data-block-type="features"');
  });
  it('logo images are named by the logo name and video gets an accessible name', () => {
    const html = render([
      b('logo-cloud', { items: [{ name: 'Acme', image: { src: '/a.svg', alt: '' } }] }),
      { ...b('media', { kind: 'video', src: '/v.mp4', alt: 'Demo', caption: '' }), id: 'b2' },
    ]);
    expect(html).toContain('alt="Acme"');
    expect(html).toContain('aria-label="Demo"');
  });
  it('custom pricing slot receives slugs, never prices; all expands to "all"', () => {
    let seen: unknown;
    render([b('pricing', { plans: 'all', showCreditPacks: false })], { pricing: (p) => ((seen = p), null) });
    expect(seen).toMatchObject({ plans: 'all', showCreditPacks: false, locale: 'en' });
    expect(JSON.stringify(seen)).not.toMatch(/price|currency/i);
  });
  it('newsletter slot replaces the default form and gets the checked action', () => {
    let action = '';
    const html = render([b('newsletter', { formAction: 'https://m.example.test/s', emailLabel: 'E', buttonLabel: 'B' })], {
      newsletter: (p) => ((action = p.formAction), <span>custom</span>),
    });
    expect(action).toBe('https://m.example.test/s');
    expect(html).toContain('custom');
    expect(html).not.toContain('<form');
  });
  it('rendering never throws for hostile shapes and skips them', () => {
    const issues: BlockRenderIssue[] = [];
    expect(() =>
      render([null, undefined, { id: 'z', type: '__proto__' }, { id: 'y', type: 'constructor' }, { id: 'x', type: 'toString' }, 'str'], {}, issues),
    ).not.toThrow();
    expect(issues.filter((i) => i.code === 'unknown-block').length).toBeGreaterThanOrEqual(3);
  });
});
