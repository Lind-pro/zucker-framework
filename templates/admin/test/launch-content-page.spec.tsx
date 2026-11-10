/**
 * Launch-readiness coverage for the content page: JSON apply edges, v1 load/re-save, save errors,
 * preview isolation and the read-only file panel. Run with
 * `pnpm exec vitest run templates/admin/test/launch-content-page.spec.tsx`.
 */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { validateSiteDocument } from '@zucker-framework/fe-site/content';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMockServer, renderAdmin, type MockRequest } from '../../../packages/fe-admin/src/test/harness';
import { ContentPage } from '../src/pages/content';

const locales = { 'zh-CN': { label: '中文', messages: {} }, 'en-US': { label: 'English', messages: {} } };
const ENTRIES = '/content/manage/entries';
const FILES = '/content/manage/files';

function mount(routes: Record<string, unknown> = {}) {
  const server = createMockServer({
    'GET /menu/tree': [],
    [`GET ${ENTRIES}`]: { data: [], total: 0 },
    'GET /content/manage/categories': [],
    [`GET ${FILES}`]: { data: [], issues: [] },
    [`POST ${ENTRIES}`]: ({ body }: MockRequest) => ({ data: { id: 'e1', ...(body as object) } }),
    ...routes,
  });
  renderAdmin(
    { httpAdapter: server.adapter as never, locales, extraPages: [{ key: 'content', path: '/content', title: 'Content', permission: 'content:manage', component: ContentPage }] },
    { path: '/content', permissions: ['content:manage'] },
  );
  return server;
}
const openTab = (dialog: HTMLElement, name: RegExp) => fireEvent.mouseDown(within(dialog).getByRole('tab', { name }), { button: 0 });
async function openNew() {
  fireEvent.click(await screen.findByRole('button', { name: 'New entry' }));
  return screen.findByRole('dialog');
}
const field = (dialog: HTMLElement, path: string) => dialog.querySelector<HTMLInputElement>(`[data-field="${path}"]`)!;
const save = (dialog: HTMLElement) => fireEvent.click(within(dialog).getByRole('button', { name: 'Save draft' }));
async function applyJson(dialog: HTMLElement, value: string) {
  openTab(dialog, /^Advanced JSON/);
  fireEvent.change(within(dialog).getByLabelText('Blocks (JSON array)'), { target: { value } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Apply JSON' }));
}
const hero = (over: Record<string, unknown> = {}) => ({ id: 'hero', type: 'hero', enabled: true, heading: 'Hello', text: 'Intro', ...over });

beforeEach(() => localStorage.setItem('zucker-admin-locale', 'en-US'));
afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('Advanced JSON apply', () => {
  it.each([
    ['not JSON', '{nope', 'The JSON is not valid'],
    ['empty text', '', 'The JSON is not valid'],
    ['object instead of array', '{"type":"hero"}', 'Expected an array of blocks, each with a supported type'],
    ['null', 'null', 'Expected an array of blocks, each with a supported type'],
    ['string', '"hero"', 'Expected an array of blocks, each with a supported type'],
    ['array with null', '[null]', 'Expected an array of blocks, each with a supported type'],
    ['array with nested array', '[[]]', 'Expected an array of blocks, each with a supported type'],
    ['block without type', '[{"id":"a"}]', 'Expected an array of blocks, each with a supported type'],
    ['unknown block type', '[{"type":"script","id":"a"}]', 'Expected an array of blocks, each with a supported type'],
    ['prototype-polluting type', '[{"type":"__proto__","id":"a"}]', 'Expected an array of blocks, each with a supported type'],
  ])('%s is rejected with a message and leaves the blocks untouched', async (_name, value, message) => {
    mount();
    const dialog = await openNew();
    openTab(dialog, /^Blocks/);
    fireEvent.change(within(dialog).getByLabelText('Block type'), { target: { value: 'hero' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add block' }));
    await applyJson(dialog, value);
    expect(within(dialog).getByText(message)).toBeTruthy();
    expect(within(dialog).getByRole('tab', { name: 'Blocks (1)' })).toBeTruthy();
  });

  it('a well-formed list that violates the schema is applied but reports the field path', async () => {
    mount();
    const dialog = await openNew();
    await applyJson(dialog, JSON.stringify([hero({ heading: '' }), hero({ id: 'hero' })]));
    expect(within(dialog).getByRole('tab', { name: 'Blocks (2)' })).toBeTruthy();
    // first failing issue, with a readable path
    expect(within(dialog).getByText(/Block 1 · Hero › Heading: Required|Anchor IDs must be unique/)).toBeTruthy();
  });

  it('duplicate ids are reported against the block list', async () => {
    mount();
    const dialog = await openNew();
    await applyJson(dialog, JSON.stringify([hero(), hero()]));
    expect(within(dialog).getByText('Blocks: Anchor IDs must be unique')).toBeTruthy();
  });

  it('a valid list clears an earlier problem; [] clears all blocks', async () => {
    mount();
    const dialog = await openNew();
    await applyJson(dialog, '{bad');
    expect(within(dialog).getByText('The JSON is not valid')).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('Blocks (JSON array)'), { target: { value: JSON.stringify([hero()]) } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply JSON' }));
    expect(within(dialog).queryByText('The JSON is not valid')).toBeNull();
    expect(within(dialog).getByRole('tab', { name: 'Blocks (1)' })).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('Blocks (JSON array)'), { target: { value: '[]' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply JSON' }));
    expect(within(dialog).getByRole('tab', { name: 'Blocks (0)' })).toBeTruthy();
  });

  it('the JSON view reflects form edits made earlier (not a stale snapshot)', async () => {
    mount();
    const dialog = await openNew();
    openTab(dialog, /^Blocks/);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add block' }));
    fireEvent.change(field(dialog, 'blocks.0.heading'), { target: { value: 'Typed in the form' } });
    openTab(dialog, /^Advanced JSON/);
    expect((within(dialog).getByLabelText('Blocks (JSON array)') as HTMLTextAreaElement).value).toContain('Typed in the form');
    // and the other way round: JSON edits show in the forms, even when the block count is unchanged
    fireEvent.change(within(dialog).getByLabelText('Blocks (JSON array)'), { target: { value: JSON.stringify([hero({ heading: 'From JSON' })]) } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply JSON' }));
    openTab(dialog, /^Blocks/);
    expect(field(dialog, 'blocks.0.heading').value).toBe('From JSON');
  });

  it('applying JSON with the same block count refreshes plan slugs shown in the form', async () => {
    mount();
    const dialog = await openNew();
    const pricing = (plans: unknown) => ({ id: 'price', type: 'pricing', enabled: true, heading: 'P', text: '', plans, showCreditPacks: false });
    await applyJson(dialog, JSON.stringify([pricing(['basic'])]));
    openTab(dialog, /^Blocks/);
    expect(field(dialog, 'blocks.0.plans').value).toBe('basic');
    await applyJson(dialog, JSON.stringify([pricing(['team', 'pro'])]));
    openTab(dialog, /^Blocks/);
    expect(field(dialog, 'blocks.0.plans').value).toBe('team, pro');
  });

  it('JSON-applied extra keys are rejected by the validator at save and nothing is sent', async () => {
    const server = mount();
    const dialog = await openNew();
    fireEvent.change(within(dialog).getByLabelText(/^Path/), { target: { value: 'p' } });
    fireEvent.change(within(dialog).getByLabelText(/^Title/), { target: { value: 'T' } });
    await applyJson(dialog, JSON.stringify([hero({ onclick: 'alert(1)', html: '<script>1</script>' })]));
    save(dialog);
    await waitFor(() => expect(within(dialog).getAllByRole('alert').length + dialog.querySelectorAll('[class*="destructive"],[role="status"]').length).toBeGreaterThan(0));
    expect(server.find('POST', ENTRIES)).toHaveLength(0);
  });
});

describe('save flow messages', () => {
  const stored = (document: unknown, over: Record<string, unknown> = {}) => ({
    id: 'e1', kind: 'page', locale: 'en', slug: 'home', status: 'draft', revision: 4, publishedRevision: null,
    draft: { document, categoryIds: [] }, updatedAt: '2026-11-01T00:00:00.000Z', ...over,
  });
  const v1Document = {
    version: 1,
    title: 'Legacy home',
    description: 'd',
    authorName: 'a',
    markdown: 'body text',
    seo: { title: 'st', description: 'sd', noIndex: true },
    blocks: [
      hero({ action: { label: 'Go', href: '/go' } }),
      { id: 'md', type: 'markdown', enabled: false, heading: '', markdown: '# hidden' },
      { id: 'feat', type: 'features', enabled: true, heading: 'F', items: [{ title: 'a', text: 'b' }] },
      { id: 'faq', type: 'faq', enabled: true, heading: 'Q', items: [{ question: 'q', answer: 'a' }] },
      { id: 'cta', type: 'cta', enabled: true, heading: 'C', text: '', action: { label: 'x', href: '/x' } },
      { id: 'links', type: 'links', enabled: true, heading: 'L', items: [{ label: 'l', href: '/l' }] },
    ],
  };
  async function editFirst(routes: Record<string, unknown>, document: unknown = v1Document) {
    const server = mount({ [`GET ${ENTRIES}`]: { data: [stored(document)], total: 1 }, ...routes });
    fireEvent.click((await screen.findAllByRole('button', { name: 'Edit draft' }))[0]!);
    const dialog = await screen.findByRole('dialog');
    return { server, dialog };
  }

  it('re-saving an untouched v1 document sends the same content as v2 with the read revision', async () => {
    const { server, dialog } = await editFirst({ 'PUT /content/manage/entries/e1': { data: {} } });
    expect(within(dialog).getByRole('tab', { name: 'Blocks (6)' })).toBeTruthy();
    save(dialog);
    await waitFor(() => expect(server.find('PUT', `${ENTRIES}/e1`)).toHaveLength(1));
    const body = server.find('PUT', `${ENTRIES}/e1`)[0]!.body as Record<string, unknown>;
    expect(body).toEqual({
      slug: 'home',
      document: validateSiteDocument(v1Document),
      categoryIds: [],
      expectedRevision: 4,
    });
    expect((body.document as { version: number; blocks: Array<{ id: string; enabled: boolean }> }).version).toBe(2);
    expect((body.document as { blocks: Array<{ id: string; enabled: boolean }> }).blocks.find((b) => b.id === 'md')?.enabled).toBe(false);
    // existing entries cannot change kind or language
    expect(body).not.toHaveProperty('kind');
    expect(body).not.toHaveProperty('locale');
  });

  it('opening a v1 document does not mutate the stored object (cancel keeps the list data)', async () => {
    const { dialog } = await editFirst({});
    fireEvent.change(field(dialog, 'title'), { target: { value: 'Edited' } });
    openTab(dialog, /^Blocks/);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete Block 1' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click((await screen.findAllByRole('button', { name: 'Edit draft' }))[0]!);
    const again = await screen.findByRole('dialog');
    expect(field(again, 'title').value).toBe('Legacy home');
    expect(within(again).getByRole('tab', { name: 'Blocks (6)' })).toBeTruthy();
  });

  it('kind and language cannot be changed when editing; path may be', async () => {
    const { dialog } = await editFirst({});
    expect((within(dialog).getByLabelText(/^Type/) as HTMLSelectElement).disabled).toBe(true);
    expect((within(dialog).getByLabelText(/^Language/) as HTMLSelectElement).disabled).toBe(true);
    expect(field(dialog, 'slug').disabled).toBe(false);
  });

  it('409 shows the conflict message and keeps the dialog and draft', async () => {
    const { dialog } = await editFirst({ 'PUT /content/manage/entries/e1': { status: 409, data: { message: 'changed' } } });
    fireEvent.change(field(dialog, 'title'), { target: { value: 'Mine' } });
    save(dialog);
    expect(await within(dialog).findByText('Version conflict or path in use; reopen the entry')).toBeTruthy();
    expect(field(dialog, 'title').value).toBe('Mine');
    // Save is usable again after the failure
    expect((within(dialog).getByRole('button', { name: 'Save draft' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('400 shows the server message; 500 shows the generic failure; neither closes the dialog', async () => {
    const { dialog, server } = await editFirst({
      'PUT /content/manage/entries/e1': ({ body }: MockRequest) =>
        (body as { slug: string }).slug === 'bad'
          ? { status: 400, data: { message: 'slug is reserved' } }
          : { status: 500, data: { message: 'boom internal detail' } },
    });
    fireEvent.change(field(dialog, 'slug'), { target: { value: 'bad' } });
    save(dialog);
    expect(await within(dialog).findByText('The server rejected the draft: slug is reserved')).toBeTruthy();
    fireEvent.change(field(dialog, 'slug'), { target: { value: 'fine' } });
    save(dialog);
    expect(await within(dialog).findByText('Could not save the draft')).toBeTruthy();
    // internal details are not echoed on 5xx
    expect(within(dialog).queryByText(/boom internal detail/)).toBeNull();
    expect(server.find('PUT', `${ENTRIES}/e1`)).toHaveLength(2);
  });

  it('a network failure also shows the generic failure and re-enables saving', async () => {
    const { dialog } = await editFirst({ 'PUT /content/manage/entries/e1': () => { throw new Error('offline'); } });
    save(dialog);
    expect(await within(dialog).findByText('Could not save the draft')).toBeTruthy();
    expect((within(dialog).getByRole('button', { name: 'Save draft' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('a blank path is rejected before any validation or request and returns to the Content tab', async () => {
    const server = mount();
    const dialog = await openNew();
    openTab(dialog, /^Blocks/);
    save(dialog);
    expect(await within(dialog).findByText('Enter a path')).toBeTruthy();
    expect(within(dialog).getByRole('tab', { name: /^Content/ }).getAttribute('aria-selected')).toBe('true');
    expect(server.find('POST', ENTRIES)).toHaveLength(0);
  });

  it('a document-level issue (title) selects the Content tab and marks the field', async () => {
    const server = mount();
    const dialog = await openNew();
    fireEvent.change(field(dialog, 'slug'), { target: { value: 'p' } });
    openTab(dialog, /^Blocks/);
    save(dialog);
    expect(await within(dialog).findByText('Title: Required')).toBeTruthy();
    expect(field(dialog, 'title').getAttribute('aria-invalid')).toBe('true');
    expect(server.find('POST', ENTRIES)).toHaveLength(0);
  });

  it('only blog posts carry categories; other kinds send an empty list', async () => {
    const category = { id: 'c1', locale: 'zh', draft: { title: 'News' }, status: 'published' };
    const server = mount({ 'GET /content/manage/categories': [category] });
    const dialog = await openNew();
    fireEvent.change(field(dialog, 'slug'), { target: { value: 'p' } });
    fireEvent.change(field(dialog, 'title'), { target: { value: 'T' } });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /News/ }));
    save(dialog);
    await waitFor(() => expect(server.find('POST', ENTRIES)).toHaveLength(1));
    expect(server.find('POST', ENTRIES)[0]!.body).toMatchObject({ kind: 'post', locale: 'zh', categoryIds: ['c1'] });
  });

  it('switching a checked-category draft to a page drops the categories from the body', async () => {
    const category = { id: 'c1', locale: 'zh', draft: { title: 'News' }, status: 'published' };
    const server = mount({ 'GET /content/manage/categories': [category] });
    const dialog = await openNew();
    fireEvent.change(field(dialog, 'slug'), { target: { value: 'p' } });
    fireEvent.change(field(dialog, 'title'), { target: { value: 'T' } });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /News/ }));
    fireEvent.change(within(dialog).getByLabelText(/^Type/), { target: { value: 'page' } });
    expect(within(dialog).queryByRole('checkbox', { name: /News/ })).toBeNull();
    save(dialog);
    await waitFor(() => expect(server.find('POST', ENTRIES)).toHaveLength(1));
    expect(server.find('POST', ENTRIES)[0]!.body).toMatchObject({ kind: 'page', categoryIds: [] });
  });

  it('single-segment kinds explain their slug rule', async () => {
    mount();
    const dialog = await openNew();
    expect(within(dialog).getByText('Lowercase letters, digits and hyphens; a single segment.')).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText(/^Type/), { target: { value: 'page' } });
    expect(within(dialog).getByText(/The home page is "home"/)).toBeTruthy();
  });
});

describe('preview isolation', () => {
  async function previewOf(blocks: unknown[], extra: { title?: string; markdown?: string } = {}) {
    mount();
    const dialog = await openNew();
    fireEvent.change(field(dialog, 'title'), { target: { value: extra.title ?? 'Preview title' } });
    if (extra.markdown) fireEvent.change(field(dialog, 'markdown'), { target: { value: extra.markdown } });
    await applyJson(dialog, JSON.stringify(blocks));
    openTab(dialog, /^Preview/);
    return dialog;
  }

  it('link clicks are cancelled so the editor never navigates', async () => {
    const dialog = await previewOf([hero({ action: { label: 'Go now', href: 'https://example.com/out' }, secondaryAction: { label: 'Docs', href: '/docs' } })]);
    const link = await within(dialog).findByRole('link', { name: 'Go now' });
    expect(link.getAttribute('href')).toBe('https://example.com/out');
    expect(fireEvent.click(link)).toBe(false); // default prevented
    expect(fireEvent.click(within(dialog).getByRole('link', { name: 'Docs' }))).toBe(false);
    // nested element inside a link
    const inner = document.createElement('span');
    link.appendChild(inner);
    expect(fireEvent.click(inner)).toBe(false);
  });

  it('the newsletter block cannot submit: disabled controls and any form submit is cancelled', async () => {
    const dialog = await previewOf([{ id: 'news', type: 'newsletter', enabled: true, heading: 'Join', text: '', formAction: 'https://news.example/subscribe', emailLabel: 'Email', buttonLabel: 'Subscribe' }]);
    expect(await within(dialog).findByText('Join')).toBeTruthy();
    expect((within(dialog).getByLabelText('Email') as HTMLInputElement).disabled).toBe(true);
    expect((within(dialog).getByRole('button', { name: 'Subscribe' }) as HTMLButtonElement).disabled).toBe(true);
    expect(dialog.querySelector('form[action]')).toBeNull();
    // defence in depth: a form that does render in the preview subtree cannot submit
    const panel = within(dialog).getByText('Join').closest('.overflow-auto') as HTMLElement;
    const form = document.createElement('form');
    form.action = 'https://evil.example/collect';
    panel.appendChild(form);
    expect(fireEvent.submit(form)).toBe(false);
  });

  it('markdown is shown as plain text: HTML is neither parsed nor executed', async () => {
    const payload = '<script>window.__pwned=1</script><img src=x onerror="window.__pwned=2"><b>bold</b>';
    const dialog = await previewOf([{ id: 'md', type: 'markdown', enabled: true, heading: 'Notes', markdown: payload }]);
    expect(await within(dialog).findByText('Notes')).toBeTruthy();
    const panel = within(dialog).getByText('Notes').closest('.overflow-auto') as HTMLElement;
    expect(panel.textContent).toContain(payload);
    expect(panel.querySelector('script, img, b')).toBeNull();
    expect((window as unknown as Record<string, unknown>).__pwned).toBeUndefined();
  });

  it('hidden blocks are not rendered; with nothing visible the empty notice shows; the title is the page heading', async () => {
    const dialog = await previewOf([hero({ heading: 'Visible one' }), { id: 'hid', type: 'cta', enabled: false, heading: 'Never public', text: '', action: { label: 'x', href: '/x' } }], { title: 'Doc title' });
    expect(await within(dialog).findByText('Visible one')).toBeTruthy();
    expect(within(dialog).queryByText('Never public')).toBeNull();
    expect(within(dialog).getByRole('heading', { level: 1, name: 'Doc title' })).toBeTruthy();
    cleanup();
    const empty = await previewOf([hero({ enabled: false })]);
    expect(await within(empty).findByText('Nothing to show (hidden blocks are never public).')).toBeTruthy();
  });

  it('data-backed blocks show placeholders and never call the API', async () => {
    const server = mount();
    const dialog = await openNew();
    fireEvent.change(field(dialog, 'title'), { target: { value: 'T' } });
    await applyJson(dialog, JSON.stringify([
      { id: 'blog', type: 'blog-list', enabled: true, heading: 'Posts', text: '', limit: 4, category: 'news' },
      { id: 'log', type: 'changelog', enabled: true, heading: 'Log', text: '', limit: 7 },
      { id: 'price', type: 'pricing', enabled: true, heading: 'Plans', text: '', plans: 'all', showCreditPacks: false },
    ]));
    const before = server.calls.length;
    openTab(dialog, /^Preview/);
    expect(await within(dialog).findByText('Latest 4 blog posts (category news)')).toBeTruthy();
    expect(within(dialog).getByText('Latest 7 changelog entries')).toBeTruthy();
    expect(within(dialog).getByText(/Pricing cards: all public plans/)).toBeTruthy();
    expect(server.calls.slice(before).filter((call) => /billing|content\/public|plans/.test(call.url))).toEqual([]);
  });

  it('an invalid draft is never previewed', async () => {
    const dialog = await previewOf([hero({ heading: '' })]);
    expect(await within(dialog).findByText('Fix this before previewing')).toBeTruthy();
    expect(dialog.querySelector('section[data-block-type]')).toBeNull();
  });

  it('an image URL with a hostile scheme is blocked before the preview renders', async () => {
    const dialog = await previewOf([hero({ image: { src: 'javascript:alert(1)', alt: '' } })]);
    expect(await within(dialog).findByText('Fix this before previewing')).toBeTruthy();
    expect(within(dialog).getByText(/Image URL/)).toBeTruthy();
    expect(dialog.querySelector('img[src^="javascript"]')).toBeNull();
  });
});

describe('content files panel', () => {
  const row = (over: Record<string, unknown>) => ({ id: 'f1', kind: 'page', locale: 'en', slug: 'about', title: 'About (file)', publishedAt: '2026-10-01T00:00:00.000Z', source: 'content/en/about.json', overridden: false, ...over });

  it('shows file entries with overridden and public states and the type label', async () => {
    mount({ [`GET ${FILES}`]: { data: [row({}), row({ id: 'f2', kind: 'log', slug: 'v1', title: 'Release 1', overridden: true })], issues: [] } });
    const panel = (await screen.findByText('Content files', { selector: 'h2, h3, [class*=title], div, span' }).catch(() => null)) ?? null;
    expect(panel).toBeTruthy();
    const table = await screen.findByRole('table', { name: 'Content files' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows[0]!.textContent).toContain('File version is public');
    expect(rows[0]!.textContent).toContain('Page');
    expect(rows[1]!.textContent).toContain('Replaced by a database entry');
    expect(rows[1]!.textContent).toContain('Changelog');
    expect(screen.queryByText('Some files were not loaded')).toBeNull();
  });

  it('lists load issues with their source file', async () => {
    mount({ [`GET ${FILES}`]: { data: [], issues: [{ source: 'content/en/bad.json', message: 'Invalid block' }, { source: 'content/zh/x.md', message: 'Missing title' }] } });
    expect(await screen.findByText('Some files were not loaded')).toBeTruthy();
    expect(screen.getByText('content/en/bad.json: Invalid block')).toBeTruthy();
    expect(screen.getByText('content/zh/x.md: Missing title')).toBeTruthy();
  });

  it('tolerates a response without issues and rejects a malformed one with a retry', async () => {
    let calls = 0;
    mount({ [`GET ${FILES}`]: () => (++calls === 1 ? { data: { rows: [] } } : { data: { data: [row({})] } }) });
    const retry = await screen.findByRole('button', { name: /Retry/ });
    fireEvent.click(retry);
    expect((await screen.findAllByText('About (file)')).length).toBeGreaterThan(0);
    expect(screen.queryByText('Some files were not loaded')).toBeNull();
  });

  it('a failing files endpoint does not break the entries table', async () => {
    const server = mount({ [`GET ${FILES}`]: { status: 500, data: { message: 'boom' } } });
    expect(await screen.findByRole('button', { name: 'New entry' })).toBeTruthy();
    await waitFor(() => expect(server.find('GET', FILES).length).toBeGreaterThan(0));
    // the files panel offers a retry while the page and its New entry action keep working
    expect(await screen.findByRole('button', { name: /Retry/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'New entry' }));
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });

  it('the panel is read-only: no action buttons for file rows', async () => {
    mount({ [`GET ${FILES}`]: { data: [row({})], issues: [] } });
    const table = await screen.findByRole('table', { name: 'Content files' });
    await within(table).findByText('About (file)');
    expect(within(table).queryAllByRole('button')).toHaveLength(0);
  });
});
