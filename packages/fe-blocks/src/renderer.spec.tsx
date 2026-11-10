import { render } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { validateSiteDocument, type SiteBlock } from '@zucker-framework/fe-site/content';
import { BlockRenderer, defineTheme, defaultTheme, planBlocks, resolveThemeBlock } from './index';
import type { BlockRenderIssue, BlockSlots } from './index';

const image = { src: '/img/a.png', alt: 'Synthetic image' };
const blocks = [
  {
    id: 'hero',
    type: 'hero',
    heading: 'Synthetic hero',
    text: 'Hero text',
    variant: 'split',
    image,
    action: { label: 'Start', href: '/start' },
    secondaryAction: { label: 'Docs', href: 'https://example.test/docs' },
  },
  { id: 'md', type: 'markdown', heading: '', markdown: '# Body <script>x()</script>' },
  {
    id: 'features',
    type: 'features',
    heading: 'Features',
    variant: 'list',
    image,
    items: [{ title: 'Fast', text: 'Quick' }],
  },
  { id: 'faq', type: 'faq', heading: 'FAQ', items: [{ question: 'Why?', answer: 'Because' }] },
  { id: 'cta', type: 'cta', heading: 'Act now', text: '', action: { label: 'Go', href: '#top' } },
  { id: 'links', type: 'links', heading: 'Links', items: [{ label: 'Home', href: '/' }] },
  {
    id: 'logos',
    type: 'logo-cloud',
    items: [{ name: 'Acme', image: { src: '/acme.svg', alt: '' }, href: 'https://acme.test' }],
  },
  { id: 'stats', type: 'stats', heading: 'Numbers', items: [{ value: '99.9%', label: 'Uptime' }] },
  { id: 'steps', type: 'steps', heading: 'How', items: [{ title: 'Sign up', text: 'One' }] },
  {
    id: 'quotes',
    type: 'testimonials',
    heading: 'Quotes',
    items: [{ quote: 'Great', author: 'Synthetic user', avatar: image }],
  },
  {
    id: 'show',
    type: 'showcase',
    heading: 'Showcase',
    items: [{ title: 'Demo', image, href: '/demo' }],
  },
  {
    id: 'pricing',
    type: 'pricing',
    heading: 'Plans',
    plans: ['pro', 'team'],
    showCreditPacks: true,
  },
  {
    id: 'news',
    type: 'newsletter',
    heading: 'News',
    formAction: '/api/newsletter',
    emailLabel: 'Email',
    buttonLabel: 'Subscribe',
  },
  { id: 'blog', type: 'blog-list', heading: 'Blog', limit: 2, category: 'guides' },
  { id: 'log', type: 'changelog', heading: 'Changes' },
  {
    id: 'video',
    type: 'media',
    kind: 'video',
    src: '/demo.mp4',
    alt: 'Demo video',
    caption: 'Watch',
  },
  { id: 'hidden', type: 'stats', enabled: false, heading: 'Hidden stats', items: [] },
];
const document = () =>
  validateSiteDocument({ version: 2, title: 'Home', markdown: 'Intro text', blocks });
const slots = (): BlockSlots & { calls: Record<string, unknown> } => {
  const calls: Record<string, unknown> = {};
  return {
    calls,
    markdown: ({ markdown, anchorPrefix }) => (
      <div data-testid={`md-${anchorPrefix || 'doc'}`}>{markdown}</div>
    ),
    pricing: (props) => ((calls.pricing = props), (<p>Pricing slot</p>)),
    blogList: (props) => ((calls.blogList = props), (<p>Blog slot</p>)),
    changelog: (props) => ((calls.changelog = props), (<p>Changelog slot</p>)),
    resolveHref: (href, locale) => (href.startsWith('/') ? `/${locale}${href}` : href),
  };
};

describe('BlockRenderer', () => {
  it('renders every block type of the default theme and skips disabled blocks', () => {
    const issues: BlockRenderIssue[] = [];
    const s = slots();
    const view = render(
      <BlockRenderer document={document()} locale="en" slots={s} onIssue={(i) => issues.push(i)} />,
    );
    for (const block of blocks.filter((b) => b.enabled !== false))
      expect(view.container.querySelector(`section#${block.id}`), block.type).not.toBeNull();
    expect(view.container.querySelector('#hidden')).toBeNull();
    expect(view.container.textContent).not.toContain('Hidden stats');
    expect(issues).toEqual([]);
    expect(view.getByText('Start').getAttribute('href')).toBe('/en/start');
    expect(view.getByText('Docs').getAttribute('href')).toBe('https://example.test/docs');
    expect(view.getByTestId('md-doc').textContent).toBe('Intro text');
    expect(view.getByTestId('md-block-md').textContent).toContain('<script>');
    expect(view.container.querySelector('script')).toBeNull();
    expect(s.calls.pricing).toMatchObject({
      plans: ['pro', 'team'],
      showCreditPacks: true,
      locale: 'en',
    });
    expect(s.calls.blogList).toMatchObject({ limit: 2, category: 'guides' });
    expect(s.calls.changelog).toMatchObject({ limit: 5 });
    const form = view.container.querySelector('form')!;
    expect(form.getAttribute('action')).toBe('/api/newsletter');
    expect(form.getAttribute('method')).toBe('post');
    expect(view.container.querySelector('video')?.getAttribute('aria-label')).toBe('Demo video');
    expect(view.container.querySelector('img[alt="Acme"]')).not.toBeNull();
  });

  it('skips data blocks without slots and reports them', () => {
    const issues: BlockRenderIssue[] = [];
    const html = renderToStaticMarkup(
      <BlockRenderer document={document()} locale="en" onIssue={(i) => issues.push(i)} />,
    );
    expect(html).not.toContain('id="pricing"');
    expect(html).toContain('Intro text');
    expect(issues.map((i) => `${i.code}:${i.slot}:${i.blockId ?? ''}`).sort()).toEqual([
      'missing-slot:blogList:blog',
      'missing-slot:changelog:log',
      'missing-slot:markdown:',
      'missing-slot:markdown:md',
      'missing-slot:pricing:pricing',
    ]);
  });

  it('falls back to the default theme and skips unknown blocks', () => {
    const Custom = () => <section data-custom="hero">Custom hero</section>;
    const theme = defineTheme({
      name: 'editorial',
      blocks: { hero: Custom },
      tokens: { '--zb-accent': '#0f766e' },
    });
    expect(resolveThemeBlock(theme, 'hero')).toMatchObject({
      themeName: 'editorial',
      usedFallback: false,
    });
    expect(resolveThemeBlock(theme, 'faq')).toMatchObject({
      themeName: 'default',
      usedFallback: true,
    });
    expect(resolveThemeBlock(theme, 'script')).toBeNull();
    const onIssue = vi.fn();
    const doc = {
      markdown: '',
      blocks: [
        document().blocks[0],
        document().blocks[3],
        { id: 'x', type: 'carousel', enabled: true } as unknown as SiteBlock,
      ],
    };
    const html = renderToStaticMarkup(
      <BlockRenderer document={doc} theme={theme} locale="en" onIssue={onIssue} />,
    );
    expect(html).toContain('Custom hero');
    expect(html).toContain('id="faq"');
    expect(html).toContain('--zb-accent:#0f766e');
    expect(html).not.toContain('carousel');
    expect(onIssue.mock.calls.map(([i]) => `${i.code}:${i.blockType}`)).toEqual([
      'theme-fallback:faq',
      'unknown-block:carousel',
    ]);
    expect(planBlocks(doc, defaultTheme).issues).toEqual([
      { code: 'unknown-block', blockId: 'x', blockType: 'carousel', theme: 'default' },
    ]);
  });

  it('drops links the host maps to unsafe targets and refuses unsafe themes', () => {
    const onIssue = vi.fn();
    const html = renderToStaticMarkup(
      <BlockRenderer
        document={{ markdown: '', blocks: [document().blocks[4]] }}
        locale="en"
        slots={{ resolveHref: () => 'javascript:alert(1)' }}
        onIssue={onIssue}
      />,
    );
    expect(html).not.toContain('javascript');
    expect(html).not.toContain('<a');
    expect(onIssue).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'unsafe-href', blockId: 'cta', field: 'action.href' }),
    );
    expect(() => defineTheme({ name: 'Bad Name' })).toThrow();
    expect(() =>
      defineTheme({ name: 'x', tokens: { '--zb-bg': 'red; background:url(x)' } }),
    ).toThrow();
    expect(() => defineTheme({ name: 'x', blocks: { script: () => null } as never })).toThrow();
  });
});
