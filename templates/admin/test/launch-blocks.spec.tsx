/**
 * Launch-readiness coverage for the block editor field table and document helpers against the
 * shared `validateSiteDocument`, plus the form UI for every block type. Run with
 * `pnpm exec vitest run templates/admin/test/launch-blocks.spec.tsx`.
 */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import {
  SITE_BLOCK_TYPES,
  SITE_CONTENT_LIMITS as L,
  validateSiteDocument,
  type SiteBlockType,
} from '@zucker-framework/fe-site/content';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createMockServer,
  renderAdmin,
  type MockRequest,
} from '../../../packages/fe-admin/src/test/harness';
import {
  BLOCK_SPECS,
  BLOCK_TYPE_ORDER,
  checkDocument,
  createBlock,
  describeField,
  emptyDocumentDraft,
  isEditableBlockList,
  moveBlock,
  toDocumentDraft,
  uniqueBlockId,
  type BlockDraft,
  type FieldSpec,
} from '../src/features/blocks';
import { ContentPage } from '../src/pages/content';

/** The keys each block type carries in the fe-site v2 types (oracle written from `SiteBlock`). */
const TYPE_KEYS: Record<SiteBlockType, string[]> = {
  hero: ['heading', 'text', 'action', 'secondaryAction', 'variant', 'image'],
  markdown: ['heading', 'markdown'],
  features: ['heading', 'items', 'variant', 'image'],
  faq: ['heading', 'items'],
  cta: ['heading', 'text', 'action'],
  links: ['heading', 'items'],
  'logo-cloud': ['heading', 'items'],
  stats: ['heading', 'text', 'items'],
  steps: ['heading', 'text', 'items'],
  testimonials: ['heading', 'items'],
  showcase: ['heading', 'text', 'items'],
  pricing: ['heading', 'text', 'plans', 'showCreditPacks'],
  newsletter: ['heading', 'text', 'formAction', 'emailLabel', 'buttonLabel'],
  'blog-list': ['heading', 'text', 'limit', 'category'],
  changelog: ['heading', 'text', 'limit'],
  media: ['heading', 'kind', 'src', 'alt', 'caption', 'poster', 'width', 'height'],
};
const NESTED_KEYS: Partial<Record<SiteBlockType, string[]>> = {
  features: ['title', 'text'],
  faq: ['question', 'answer'],
  links: ['label', 'href'],
  'logo-cloud': ['name', 'image', 'href'],
  stats: ['value', 'label'],
  steps: ['title', 'text'],
  testimonials: ['quote', 'author', 'role', 'avatar'],
  showcase: ['title', 'text', 'image', 'href'],
};

/** A fully populated valid value for one field spec (optionals included). */
function sample(spec: FieldSpec): unknown {
  switch (spec.kind) {
    case 'text':
      return spec.key === 'formAction' ? '/api/newsletter' : spec.key === 'category' ? 'news' : 'Text';
    case 'href':
      return '/target';
    case 'integer':
      return Math.min(Math.max(2, spec.min), spec.max);
    case 'boolean':
      return true;
    case 'select':
      return spec.options[0]!.value;
    case 'image':
      return { src: '/img.png', alt: 'Alt', width: 100, height: 50 };
    case 'action':
      return { label: 'Go', href: '/go' };
    case 'plans':
      return ['pro', 'team'];
    case 'list':
      return [Object.fromEntries(spec.fields.map((f) => [f.key, sample(f)]))];
  }
}
const fullBlock = (type: SiteBlockType, id = type): BlockDraft => ({
  id,
  type,
  enabled: true,
  ...Object.fromEntries(BLOCK_SPECS[type].fields.map((f) => [f.key, sample(f)])),
});
const doc = (blocks: BlockDraft[]) => ({ ...emptyDocumentDraft(), title: 'T', blocks });

describe('field table vs validateSiteDocument', () => {
  it('has exactly one spec per supported block type, in schema order', () => {
    expect(Object.keys(BLOCK_SPECS).sort()).toEqual([...SITE_BLOCK_TYPES].sort());
    expect([...BLOCK_TYPE_ORDER]).toEqual([...SITE_BLOCK_TYPES]);
    for (const type of SITE_BLOCK_TYPES) expect(BLOCK_SPECS[type].type).toBe(type);
  });

  it.each([...SITE_BLOCK_TYPES])('%s: spec fields match the schema keys and a full block validates', (type) => {
    const spec = BLOCK_SPECS[type];
    expect(spec.fields.map((f) => f.key).sort()).toEqual([...TYPE_KEYS[type]].sort());
    const list = spec.fields.find((f) => f.kind === 'list');
    if (list && list.kind === 'list') expect(list.fields.map((f) => f.key).sort()).toEqual([...NESTED_KEYS[type]!].sort());
    const check = checkDocument(doc([fullBlock(type)]));
    expect(check.ok, JSON.stringify(!check.ok && check.issue)).toBe(true);
    // The validator keeps every key the form can write (nothing is silently dropped).
    if (check.ok) expect(Object.keys(check.document.blocks[0]!).sort()).toEqual(['enabled', 'id', 'type', ...TYPE_KEYS[type]].sort());
  });

  it.each([...SITE_BLOCK_TYPES])('%s: a fresh block fails only on required fields and the error path is a rendered field', (type) => {
    const fresh = createBlock(type, []);
    expect(fresh.id).toBe(type);
    expect(fresh.enabled).toBe(true);
    const check = checkDocument(doc([fresh]));
    if (check.ok) return;
    expect(check.issue.field).toMatch(new RegExp(`^blocks\\.0\\.`));
    // path resolves to a spec field
    expect(describeField(check.issue.field, [fresh], (_zh, en) => en)).not.toBe(check.issue.field);
  });

  it.each([...SITE_BLOCK_TYPES])('%s: text and list limits equal the validator limits', (type) => {
    const spec = BLOCK_SPECS[type];
    for (const field of spec.fields) {
      const at = (value: unknown): BlockDraft => ({ ...fullBlock(type), [field.key]: value });
      if (field.kind === 'text' && field.key !== 'formAction') {
        expect(checkDocument(doc([at('x'.repeat(field.max))])).ok, `${field.key} at max`).toBe(true);
        const over = checkDocument(doc([at('x'.repeat(field.max + 1))]));
        expect(over.ok, `${field.key} over max`).toBe(false);
        if (!over.ok) expect(over.issue.field).toBe(`blocks.0.${field.key}`);
      }
      if (field.kind === 'list') {
        const item = sample({ ...field, kind: 'list' } as FieldSpec) as unknown[];
        const many = (n: number) => Array.from({ length: n }, () => JSON.parse(JSON.stringify(item[0])));
        expect(checkDocument(doc([at(many(field.max))])).ok, `${field.key} at max`).toBe(true);
        const over = checkDocument(doc([at(many(field.max + 1))]));
        expect(over.ok, `${field.key} over max`).toBe(false);
        if (!over.ok) expect(over.issue.field).toBe(`blocks.0.${field.key}`);
      }
      if (field.kind === 'integer') {
        expect(checkDocument(doc([at(field.min)])).ok, `${field.key} min`).toBe(true);
        expect(checkDocument(doc([at(field.max)])).ok, `${field.key} max`).toBe(true);
        for (const bad of [field.min - 1, field.max + 1, '3x', 1.5]) {
          const result = checkDocument(doc([at(bad)]));
          expect(result.ok, `${field.key}=${String(bad)}`).toBe(false);
          if (!result.ok) expect(result.issue.field).toBe(`blocks.0.${field.key}`);
        }
      }
    }
  });

  it('every hostile href is rejected at the field that holds it', () => {
    for (const href of ['javascript:alert(1)', 'data:text/html,x', 'vbscript:x', ' javascript:x', '//evil.test/x', 'JaVaScRiPt:1', '/ok\u0000']) {
      const check = checkDocument(doc([{ ...fullBlock('cta'), action: { label: 'x', href } }]));
      expect(check.ok, href).toBe(false);
      if (!check.ok) expect(check.issue.field).toBe('blocks.0.action.href');
    }
    for (const href of ['/pricing', 'https://example.com/a?b=1#c', '#section']) {
      expect(checkDocument(doc([{ ...fullBlock('cta'), action: { label: 'x', href } }])).ok, href).toBe(true);
    }
  });

  it('newsletter form action accepts https or same-origin paths only', () => {
    const run = (formAction: string) => checkDocument(doc([{ ...fullBlock('newsletter'), formAction }]));
    for (const ok of ['/api/newsletter', 'https://news.example/subscribe']) expect(run(ok).ok, ok).toBe(true);
    for (const bad of ['http://news.example/s', 'javascript:x', '//news.example/s', '']) {
      const result = run(bad);
      expect(result.ok, bad).toBe(false);
      if (!result.ok) expect(result.issue.field).toBe('blocks.0.formAction');
    }
  });

  it('pricing plans: all, unique lowercase slugs, bounded, never empty', () => {
    const run = (plans: unknown) => checkDocument(doc([{ ...fullBlock('pricing'), plans }]));
    expect(run('all').ok).toBe(true);
    expect(run(['pro']).ok).toBe(true);
    expect(run(Array.from({ length: L.pricingPlans }, (_, i) => `p${i}`)).ok).toBe(true);
    for (const bad of [[], ['Pro'], ['pro', 'pro'], ['a b'], Array.from({ length: L.pricingPlans + 1 }, (_, i) => `p${i}`), 'some']) {
      expect(run(bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it('block ids: lowercase, unique, bounded; blocks capped at 32', () => {
    expect(checkDocument(doc([fullBlock('hero', 'a'), fullBlock('cta', 'a')])).ok).toBe(false);
    for (const id of ['Hero', '1hero', 'he ro', '', 'h'.repeat(65)]) expect(checkDocument(doc([fullBlock('hero', id)])).ok, id).toBe(false);
    expect(checkDocument(doc([fullBlock('hero', 'h'.repeat(64))])).ok).toBe(true);
    const many = (n: number) => Array.from({ length: n }, (_, i) => fullBlock('markdown', `m${i}`));
    expect(checkDocument(doc(many(L.blocksV2))).ok).toBe(true);
    expect(checkDocument(doc(many(L.blocksV2 + 1))).ok).toBe(false);
  });

  it('document size cap of 64 KiB is reported against the document', () => {
    const big = Array.from({ length: 6 }, (_, i) => ({ ...fullBlock('markdown', `m${i}`), markdown: 'é'.repeat(L.blockMarkdown) }));
    const check = checkDocument({ ...doc(big), markdown: '' });
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.issue).toMatchObject({ field: 'document', message: 'Document exceeds 64 KiB' });
  });
});

describe('document helpers', () => {
  it('toDocumentDraft deep-copies, upgrades to v2 and handles missing documents', () => {
    const source = { version: 1 as const, title: 'T', description: '', authorName: '', markdown: '', seo: { title: '', description: '', noIndex: false }, blocks: [{ id: 'hero', type: 'hero' as const, enabled: true, heading: 'H', text: '' }] };
    const draft = toDocumentDraft(source);
    expect(draft.version).toBe(2);
    (draft.blocks[0] as Record<string, unknown>).heading = 'changed';
    draft.seo.title = 'changed';
    expect((source.blocks[0] as { heading: string }).heading).toBe('H');
    expect(source.seo.title).toBe('');
    expect(toDocumentDraft(undefined)).toEqual(emptyDocumentDraft());
  });

  it('v1 documents (all v1 block types, hidden block) load and re-validate losslessly', () => {
    const v1 = {
      version: 1 as const, title: 'Legacy', description: 'd', authorName: 'a', markdown: 'body',
      seo: { title: 's', description: 'sd', noIndex: true },
      blocks: [
        { id: 'hero', type: 'hero', enabled: true, heading: 'H', text: 'T', action: { label: 'Go', href: '/go' } },
        { id: 'md', type: 'markdown', enabled: false, heading: '', markdown: '# hi' },
        { id: 'feat', type: 'features', enabled: true, heading: 'F', items: [{ title: 'a', text: 'b' }] },
        { id: 'faq', type: 'faq', enabled: true, heading: 'Q', items: [{ question: 'q', answer: 'a' }] },
        { id: 'cta', type: 'cta', enabled: true, heading: 'C', text: '', action: { label: 'x', href: '/x' } },
        { id: 'links', type: 'links', enabled: true, heading: 'L', items: [{ label: 'l', href: '/l' }] },
      ],
    };
    const expected = validateSiteDocument(v1);
    const check = checkDocument(toDocumentDraft(v1 as never));
    expect(check.ok).toBe(true);
    if (check.ok) {
      expect(check.document).toEqual(expected);
      expect(check.document.version).toBe(2);
      expect(check.document.blocks.map((b) => [b.id, b.enabled])).toEqual(v1.blocks.map((b) => [b.id, b.enabled]));
      expect(check.document.seo.noIndex).toBe(true);
    }
  });

  it('uniqueBlockId, moveBlock and isEditableBlockList edges', () => {
    expect(uniqueBlockId('hero', [])).toBe('hero');
    expect(uniqueBlockId('hero', [{ id: 'hero' }])).toBe('hero-2');
    expect(uniqueBlockId('hero', [{ id: 'hero' }, { id: 'hero-2' }, { id: 'hero-4' }])).toBe('hero-3');
    expect(createBlock('faq', [{ id: 'faq' }]).id).toBe('faq-2');
    expect(moveBlock([1, 2, 3], 0, 2)).toEqual([2, 3, 1]);
    expect(moveBlock([1, 2, 3], 2, 1)).toEqual([1, 3, 2]);
    for (const [from, to] of [[0, -1], [2, 3], [1, 1]] as const) expect(moveBlock([1, 2, 3], from, to)).toEqual([1, 2, 3]);
    const source = [1, 2];
    expect(moveBlock(source, 0, 0)).not.toBe(source);
    expect(isEditableBlockList([])).toBe(true);
    expect(isEditableBlockList([{ type: 'hero' }, { type: 'media' }])).toBe(true);
    for (const bad of [null, {}, 'x', [null], [[]], ['hero'], [{ type: 'unknown' }], [{}], [{ type: 1 }], [{ type: 'hero' }, 3]])
      expect(isEditableBlockList(bad), JSON.stringify(bad)).toBe(false);
  });

  it('describeField covers document, action, plans and unknown paths', () => {
    const tx = (_zh: string, en: string) => en;
    expect(describeField('title', [], tx)).toBe('Title');
    expect(describeField('document', [], tx)).toBe('Document');
    expect(describeField('blocks', [], tx)).toBe('Blocks');
    expect(describeField('blocks.1.action.href', [{ type: 'hero' }, { type: 'cta' }], tx)).toBe('Block 2 · Call to action › Button › URL');
    expect(describeField('blocks.0.plans.2', [{ type: 'pricing' }], tx)).toBe('Block 1 · Pricing › Plans 3');
    expect(describeField('blocks.0.id', [{ type: 'hero' }], tx)).toBe('Block 1 · Hero › Anchor ID');
    expect(describeField('blocks.5.heading', [], tx)).toBe('Block 6 › heading');
    expect(describeField('mystery', [], tx)).toBe('mystery');
    expect(describeField('blocks.0.items.0.title', [{ type: 'features' }], (zh) => zh)).toBe('内容块 1 · 功能列表 › 功能 1 › 标题');
  });
});

/* ------------------------------ form UI ------------------------------ */

const locales = { 'zh-CN': { label: '中文', messages: {} }, 'en-US': { label: 'English', messages: {} } };
const ENTRIES = '/content/manage/entries';
function mount(routes: Record<string, unknown> = {}, permissions = ['content:manage']) {
  const server = createMockServer({
    'GET /menu/tree': [],
    [`GET ${ENTRIES}`]: { data: [], total: 0 },
    'GET /content/manage/categories': [],
    'GET /content/manage/files': { data: [], issues: [] },
    [`POST ${ENTRIES}`]: ({ body }: MockRequest) => ({ data: { id: 'e1', ...(body as object) } }),
    ...routes,
  });
  renderAdmin(
    { httpAdapter: server.adapter as never, locales, extraPages: [{ key: 'content', path: '/content', title: 'Content', permission: 'content:manage', component: ContentPage }] },
    { path: '/content', permissions },
  );
  return server;
}
const openTab = (dialog: HTMLElement, name: RegExp) => fireEvent.mouseDown(within(dialog).getByRole('tab', { name }), { button: 0 });
async function openNew() {
  fireEvent.click(await screen.findByRole('button', { name: 'New entry' }));
  return screen.findByRole('dialog');
}
function addBlock(dialog: HTMLElement, type: string) {
  fireEvent.change(within(dialog).getByLabelText('Block type'), { target: { value: type } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Add block' }));
}
const save = (dialog: HTMLElement) => fireEvent.click(within(dialog).getByRole('button', { name: 'Save draft' }));

beforeEach(() => localStorage.setItem('zucker-admin-locale', 'en-US'));
afterEach(() => {
  cleanup();
  localStorage.clear();
});

/** Fill whichever input the current validator issue points at, as an editor would. */
function fillIssueField(dialog: HTMLElement, path: string) {
  const element = dialog.querySelector<HTMLElement>(`[data-field="${CSS.escape(path)}"]`);
  expect(element, `no rendered field for issue path ${path}`).toBeTruthy();
  expect(['INPUT', 'TEXTAREA']).toContain(element!.tagName);
  const key = path.split('.').pop()!;
  const value = key === 'formAction' ? '/api/newsletter' : /href|src|poster/i.test(key) ? '/target' : key === 'id' ? 'x1' : 'Text';
  fireEvent.change(element!, { target: { value } });
}

describe('form UI per block type', () => {
  it.each([...SITE_BLOCK_TYPES])('%s: new block can be completed purely through the form and is saved as v2', async (type) => {
    const server = mount();
    const dialog = await openNew();
    fireEvent.change(within(dialog).getByLabelText(/^Path/), { target: { value: 'p' } });
    fireEvent.change(within(dialog).getByLabelText(/^Title/), { target: { value: 'T' } });
    openTab(dialog, /^Blocks/);
    addBlock(dialog, type);
    const spec = BLOCK_SPECS[type];
    // every top-level field of the table is rendered
    for (const field of spec.fields) {
      if (['text', 'href', 'integer', 'select', 'boolean'].includes(field.kind))
        expect(dialog.querySelector(`[data-field="blocks.0.${field.key}"]`), `${type}.${field.key}`).toBeTruthy();
      else if (field.kind === 'plans') expect(within(dialog).getByLabelText(/^Plans/)).toBeTruthy();
      else if (field.kind === 'list') expect(within(dialog).getAllByText(field.label[1]).length).toBeGreaterThan(0);
    }
    for (let attempt = 0; attempt < 25; attempt++) {
      if (server.find('POST', ENTRIES).length) break;
      save(dialog);
      await waitFor(() => expect(dialog.querySelector('[role="alert"]') || server.find('POST', ENTRIES).length || within(dialog).queryAllByText(/: /).length).toBeTruthy());
      if (server.find('POST', ENTRIES).length) break;
      const focused = await waitFor(() => {
        const bad = dialog.querySelector('[aria-invalid="true"], fieldset[data-field]');
        if (!bad) throw new Error('no invalid field rendered for the reported issue');
        return bad as HTMLElement;
      });
      fillIssueField(dialog, focused.getAttribute('data-field')!);
    }
    await waitFor(() => expect(server.find('POST', ENTRIES)).toHaveLength(1));
    const body = server.find('POST', ENTRIES)[0]!.body as { document: { version: number; blocks: Array<{ type: string }> } };
    expect(body.document.version).toBe(2);
    expect(body.document.blocks.map((b) => b.type)).toEqual([type]);
    expect(validateSiteDocument(body.document).blocks).toHaveLength(1);
  });

  it('list fields respect their cap: add is disabled at the maximum and delete/reorder work', async () => {
    mount();
    const dialog = await openNew();
    openTab(dialog, /^Blocks/);
    addBlock(dialog, 'stats');
    const add = () => within(dialog).getByRole('button', { name: 'Add figure' }) as HTMLButtonElement;
    for (let i = 1; i < L.statItems; i++) fireEvent.click(add());
    expect(add().disabled).toBe(true);
    expect(within(dialog).getByText(`${L.statItems}/${L.statItems}`)).toBeTruthy();
    fireEvent.change(dialog.querySelector('[data-field="blocks.0.items.0.value"]')!, { target: { value: 'first' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move Figure 1 down' }));
    expect((dialog.querySelector('[data-field="blocks.0.items.1.value"]') as HTMLInputElement).value).toBe('first');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete Figure 2' }));
    expect(add().disabled).toBe(false);
    expect(dialog.querySelector('[data-field="blocks.0.items.1.value"]') as HTMLInputElement).toBeTruthy();
    expect((dialog.querySelector(`[data-field="blocks.0.items.${L.statItems - 2}.value"]`) as HTMLInputElement)).toBeTruthy();
    expect(dialog.querySelector(`[data-field="blocks.0.items.${L.statItems - 1}.value"]`)).toBeNull();
  });

  it('add block is disabled at the 32-block cap (loaded through JSON)', async () => {
    mount();
    const dialog = await openNew();
    openTab(dialog, /^Advanced JSON/);
    const blocks = Array.from({ length: L.blocksV2 }, (_, i) => ({ id: `m${i}`, type: 'markdown', enabled: true, heading: '', markdown: 'x' }));
    fireEvent.change(within(dialog).getByLabelText('Blocks (JSON array)'), { target: { value: JSON.stringify(blocks) } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply JSON' }));
    openTab(dialog, /^Blocks/);
    expect((within(dialog).getByRole('button', { name: 'Add block' }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(dialog).getByText(`${L.blocksV2}/${L.blocksV2}`)).toBeTruthy();
  });

  it('optional image/action objects are added and removed; removing drops the key from the saved block', async () => {
    const server = mount();
    const dialog = await openNew();
    fireEvent.change(within(dialog).getByLabelText(/^Path/), { target: { value: 'p' } });
    fireEvent.change(within(dialog).getByLabelText(/^Title/), { target: { value: 'T' } });
    openTab(dialog, /^Blocks/);
    addBlock(dialog, 'hero');
    fireEvent.change(dialog.querySelector('[data-field="blocks.0.heading"]')!, { target: { value: 'H' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add primary button' }));
    fireEvent.change(dialog.querySelector('[data-field="blocks.0.action.label"]')!, { target: { value: 'Go' } });
    fireEvent.change(dialog.querySelector('[data-field="blocks.0.action.href"]')!, { target: { value: '/go' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add image' }));
    fireEvent.change(dialog.querySelector('[data-field="blocks.0.image.src"]')!, { target: { value: '/hero.png' } });
    fireEvent.change(dialog.querySelector('[data-field="blocks.0.variant"]')!, { target: { value: 'split' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove image' }));
    expect(dialog.querySelector('[data-field="blocks.0.image.src"]')).toBeNull();
    save(dialog);
    await waitFor(() => expect(server.find('POST', ENTRIES)).toHaveLength(1));
    const block = (server.find('POST', ENTRIES)[0]!.body as { document: { blocks: Array<Record<string, unknown>> } }).document.blocks[0]!;
    expect(block).toMatchObject({ heading: 'H', variant: 'split', action: { label: 'Go', href: '/go' } });
    expect(block).not.toHaveProperty('image');
    expect(block).not.toHaveProperty('secondaryAction');
  });

  it('an image thumbnail is shown only for a safe URL', async () => {
    mount();
    const dialog = await openNew();
    openTab(dialog, /^Blocks/);
    addBlock(dialog, 'hero');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add image' }));
    const src = dialog.querySelector('[data-field="blocks.0.image.src"]')!;
    fireEvent.change(src, { target: { value: 'javascript:alert(1)' } });
    expect(dialog.querySelector('img')).toBeNull();
    fireEvent.change(src, { target: { value: 'https://cdn.example.test/a.png' } });
    expect(dialog.querySelector('img')?.getAttribute('src')).toBe('https://cdn.example.test/a.png');
    expect(dialog.querySelector('img')?.getAttribute('referrerpolicy')).toBe('no-referrer');
  });

  it('collapsing a block hides its form; an issue inside a collapsed block re-expands it and focuses the field', async () => {
    mount();
    const dialog = await openNew();
    fireEvent.change(within(dialog).getByLabelText(/^Path/), { target: { value: 'p' } });
    fireEvent.change(within(dialog).getByLabelText(/^Title/), { target: { value: 'T' } });
    openTab(dialog, /^Blocks/);
    addBlock(dialog, 'hero');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Collapse Block 1' }));
    expect(dialog.querySelector('[data-field="blocks.0.heading"]')).toBeNull();
    save(dialog);
    const heading = await waitFor(() => {
      const el = dialog.querySelector<HTMLInputElement>('[data-field="blocks.0.heading"]');
      if (!el) throw new Error('block still collapsed');
      return el;
    });
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });

  it('delete block removes it and keeps the others in order', async () => {
    mount();
    const dialog = await openNew();
    openTab(dialog, /^Blocks/);
    addBlock(dialog, 'hero');
    addBlock(dialog, 'faq');
    addBlock(dialog, 'hero');
    const names = () => Array.from(dialog.querySelectorAll('[data-block-path] .truncate')).map((n) => n.textContent);
    expect(names()).toEqual(['1. Hero#hero', '2. FAQ#faq', '3. Hero#hero-2']);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete Block 2' }));
    expect(names()).toEqual(['1. Hero#hero', '2. Hero#hero-2']);
    expect(within(dialog).getByRole('tab', { name: 'Blocks (2)' })).toBeTruthy();
  });
});
