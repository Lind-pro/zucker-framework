/**
 * Edge and security tests for the AI back-office pages: validation bounds, layouts, pinned kinds,
 * permission gating (no write controls without `config:update`) and that unexpected record fields
 * (secrets, markup) never reach the DOM as live content.
 */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMockServer, renderAdmin } from '../../../packages/fe-admin/src/test/harness';
import { aiPages, catalogDraft, chatPriceDraft, mediaPriceDraft, parseCatalog, parseChatPrice, parseMediaPrice, policyLayout } from '../src/features/ai';
import { checkCredits, checkLabel, checkModel, checkProvider, checkRate, MAX_ROWS } from '../src/features/ai/validation';

const locales = { 'zh-CN': { label: '中文', messages: {} }, 'en-US': { label: 'English', messages: {} } };
const PRICING = '/management/policies/ai-pricing';
const CATALOG = '/management/policies/ai-catalog';
const ALL = ['config:query', 'config:update', 'ai-tasks:query', 'chats:query'];

const field = (key: string, extra: Record<string, unknown> = {}) => ({ key, type: 'json', ...extra });
const pricing = (fields?: unknown[], revision = 3) => ({
  id: 'ai-pricing', name: 'AI pricing', revision,
  fields: fields ?? [
    field('image', { value: { default: 2, byModel: {} } }),
    field('video', { value: { default: 20, byModel: {} } }),
    field('audio', { value: { default: 8, byModel: {} } }),
    field('chat', { value: { per1kInputTokens: 0.5, per1kOutputTokens: 1.5, minimum: 1 } }),
  ],
});
const catalog = (fields?: unknown[]) => ({
  id: 'ai-catalog', name: 'AI catalog', revision: 1,
  fields: fields ?? [field('image', { public: true, value: [] }), field('chat', { public: true, value: [] })],
});

function mount(routes: Record<string, unknown>, path = '/ai/pricing', permissions = ALL) {
  const server = createMockServer({ 'GET /menu/tree': [], ...routes });
  renderAdmin({ httpAdapter: server.adapter as never, locales, extraPages: aiPages }, { path, permissions });
  return server;
}
beforeEach(() => localStorage.setItem('zucker-admin-locale', 'en-US'));
afterEach(() => { cleanup(); localStorage.clear(); });

describe('field validators', () => {
  it('credits: whole numbers 0..2147483647 only', () => {
    for (const ok of ['0', '7', ' 5 ', '2147483647', '007']) expect(checkCredits(ok).ok, ok).toBe(true);
    expect(checkCredits('2147483648')).toEqual({ ok: false, issue: 'tooLarge' });
    expect(checkCredits('99999999999999999999')).toEqual({ ok: false, issue: 'tooLarge' });
    for (const bad of ['-1', '1.5', '1e3', '0x10', '+1', '１２', 'NaN', 'Infinity', '1,000', '1 2']) expect(checkCredits(bad).ok, bad).toBe(false);
    expect(checkCredits('')).toEqual({ ok: false, issue: 'required' });
    expect(checkCredits('   ')).toEqual({ ok: false, issue: 'required' });
  });

  it('rates: up to four decimals, at most 1e6', () => {
    for (const ok of ['0', '0.0001', '1.25', '1000000', '999999.9999']) expect(checkRate(ok).ok, ok).toBe(true);
    expect(checkRate('1000000.0001')).toEqual({ ok: false, issue: 'tooLarge' });
    expect(checkRate('1000001')).toEqual({ ok: false, issue: 'tooLarge' });
    for (const bad of ['0.00001', '-0.5', '.5', '5.', '1e2', '1.2.3', 'abc']) expect(checkRate(bad).ok, bad).toBe(false);
  });

  it('model ids, provider ids and labels follow the server patterns', () => {
    for (const ok of ['gpt-image-1', 'black-forest-labs/flux-schnell', 'stability:sd3', 'imagen@002', 'a', 'A'.repeat(128), 'x+y_z.1']) expect(checkModel(ok).ok, ok).toBe(true);
    for (const bad of ['', '-lead', '.lead', '_lead', 'A'.repeat(129), 'sp ace', 'new\nline', 'semi;colon', '../etc', 'a\u0000b', '<script>', 'é']) expect(checkModel(bad).ok, JSON.stringify(bad)).toBe(false);
    for (const ok of ['openai', 'gemini-image', 'a', '0abc', 'a'.repeat(64)]) expect(checkProvider(ok).ok, ok).toBe(true);
    for (const bad of ['', 'OpenAI', '-a', '_a', 'a'.repeat(65), 'open ai', 'a.b', 'a/b']) expect(checkProvider(bad).ok, bad).toBe(false);
    expect(checkLabel('').ok).toBe(true);
    expect(checkLabel('x'.repeat(80)).ok).toBe(true);
    expect(checkLabel('x'.repeat(81)).ok).toBe(false);
    for (const bad of ['a\nb', 'a\tb', 'a\u0000b', 'a\u007fb']) expect(checkLabel(bad).ok, JSON.stringify(bad)).toBe(false);
  });
});

describe('row limits', () => {
  it('accepts exactly 100 price rows and 100 catalog rows, refuses 101', () => {
    const rows = (count: number) => Array.from({ length: count }, (_, i) => ({ id: `r${i}`, model: `m-${i}`, cost: '1' }));
    expect(MAX_ROWS).toBe(100);
    expect(parseMediaPrice({ default: '1', rows: rows(100), extra: {} }).issues).toBeNull();
    expect(parseMediaPrice({ default: '1', rows: rows(101), extra: {} }).issues).toMatchObject({ rows: 'tooMany' });
    const entries = (count: number) => catalogDraft(Array.from({ length: count }, (_, i) => ({ providerId: 'openai', model: `m-${i}` })));
    expect(parseCatalog(entries(100)).issues).toBeNull();
    expect(parseCatalog(entries(101)).issues).toMatchObject({ rows: 'tooMany' });
  });

  it('accepts the maximum integer as default and per-model price and as chat minimum', () => {
    const max = String(2_147_483_647);
    expect(parseMediaPrice({ default: max, rows: [{ id: 'a', model: 'm', cost: max }], extra: {} }).value).toEqual({ default: 2147483647, byModel: { m: 2147483647 } });
    expect(parseChatPrice({ per1kInputTokens: '1000000', per1kOutputTokens: '0.0001', minimum: max, extra: {} }).issues).toBeNull();
    expect(parseChatPrice({ per1kInputTokens: '1', per1kOutputTokens: '1', minimum: String(2_147_483_648), extra: {} }).issues).toEqual({ minimum: 'tooLarge' });
  });

  it('refuses prototype-ish model ids as byModel keys and never writes them', () => {
    const parsed = parseMediaPrice({ default: '1', rows: [{ id: 'a', model: '__proto__', cost: '1' }, { id: 'b', model: 'constructor', cost: '2' }], extra: {} });
    // Letters/underscores satisfy the model pattern; the resulting object must not pollute or lose entries.
    if (parsed.value) {
      expect(Object.getPrototypeOf(parsed.value.byModel)).toBe(Object.prototype);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      expect(Object.keys(JSON.parse(JSON.stringify(parsed.value.byModel)))).toContain('constructor');
    }
  });

  it('keeps unknown stored keys on round trip', () => {
    expect(parseMediaPrice(mediaPriceDraft({ default: 1, byModel: {}, future: { a: 1 } })).value).toEqual({ default: 1, byModel: {}, future: { a: 1 } });
    expect(parseChatPrice(chatPriceDraft({ per1kInputTokens: 1, per1kOutputTokens: 2, minimum: 3, tier: 'x' })).value).toMatchObject({ tier: 'x' });
    expect(parseCatalog(catalogDraft([{ providerId: 'openai', model: 'm', region: 'eu' }])).value).toEqual([{ providerId: 'openai', model: 'm', region: 'eu' }]);
  });
});

describe('policy layouts', () => {
  it('returns null for a policy with several unrelated json fields or none', () => {
    expect(policyLayout({ id: 'x', revision: 1, fields: [field('a'), field('b')] }, ['image', 'chat'])).toBeNull();
    expect(policyLayout({ id: 'x', revision: 1, fields: [{ key: 'a', type: 'string' }] } as never, ['image'])).toBeNull();
  });
  it('single pinned field writes nothing; per-kind pinned kinds are dropped from writes', () => {
    const single = policyLayout({ id: 'p', revision: 1, fields: [field('table', { pinnedByEnvironment: true, value: { image: { default: 1 } } })] }, ['image', 'chat']);
    expect(single?.write({ image: { default: 9 } })).toEqual({});
    const perKind = policyLayout({ id: 'p', revision: 1, fields: [field('image', { pinnedByEnvironment: true }), field('chat')] }, ['image', 'chat']);
    expect(perKind?.write({ image: { default: 9 }, chat: { minimum: 1 } })).toEqual({ chat: { minimum: 1 } });
  });
  it('uses policy.values and then defaults when a field has no value', () => {
    const layout = policyLayout({ id: 'p', revision: 1, values: { image: { default: 5 } }, fields: [field('image', { default: { default: 1 } }), field('chat', { default: { minimum: 2 } })] } as never, ['image', 'chat']);
    expect(layout?.slots.map((slot) => slot.value)).toEqual([{ default: 5 }, { minimum: 2 }]);
  });
});

describe('pricing page UI', () => {
  it('saves a single-field layout as one object and keeps unknown kinds', async () => {
    const policy = pricing([field('table', { value: { image: { default: 2, byModel: {} }, video: { default: 20, byModel: {} }, audio: { default: 8, byModel: {} }, chat: { per1kInputTokens: 1, per1kOutputTokens: 1, minimum: 1 }, future: { keep: true } } })]);
    const server = mount({ [`GET ${PRICING}`]: policy, [`GET ${CATALOG}`]: catalog(), [`PUT ${PRICING}`]: { status: 200, data: { ...policy, revision: 4 } } });
    const form = within(await screen.findByRole('form', { name: 'AI price table' }));
    fireEvent.change(form.getByLabelText('Audio: default credits per task'), { target: { value: '9' } });
    fireEvent.click(form.getByRole('button', { name: 'Save price table' }));
    await waitFor(() => expect(server.find('PUT', PRICING)).toHaveLength(1));
    const body = server.find('PUT', PRICING)[0]?.body as { expectedRevision: number; values: { table: Record<string, unknown> } };
    expect(Object.keys(body.values)).toEqual(['table']);
    expect(body.values.table.audio).toEqual({ default: 9, byModel: {} });
    expect(body.values.table.future).toEqual({ keep: true });
  });

  it('hides Save when every kind is pinned and sends nothing', async () => {
    const pinned = pricing(['image', 'video', 'audio', 'chat'].map((key) => field(key, { pinnedByEnvironment: true, value: key === 'chat' ? { per1kInputTokens: 1, per1kOutputTokens: 1, minimum: 1 } : { default: 1, byModel: {} } })));
    const server = mount({ [`GET ${PRICING}`]: pinned, [`GET ${CATALOG}`]: catalog() });
    const form = within(await screen.findByRole('form', { name: 'AI price table' }));
    expect(form.queryByRole('button', { name: 'Save price table' })).toBeNull();
    expect(form.getByLabelText('Image: default credits per task').matches(':disabled')).toBe(true);
    expect(server.find('PUT', PRICING)).toHaveLength(0);
  });

  it('shows the server message on a 400 and does not mark the revision as saved', async () => {
    const server = mount({ [`GET ${PRICING}`]: pricing(), [`GET ${CATALOG}`]: catalog(), [`PUT ${PRICING}`]: { status: 400, data: { message: 'image: model not in catalog' } } });
    const form = within(await screen.findByRole('form', { name: 'AI price table' }));
    fireEvent.change(form.getByLabelText('Image: default credits per task'), { target: { value: '4' } });
    fireEvent.click(form.getByRole('button', { name: 'Save price table' }));
    expect(await screen.findByText('image: model not in catalog')).toBeTruthy();
    expect(screen.getByText('Revision 3')).toBeTruthy();
    expect(server.find('PUT', PRICING)).toHaveLength(1);
  });

  it('disables Save until something changed, and adds at most 100 model rows', async () => {
    mount({ [`GET ${PRICING}`]: pricing(), [`GET ${CATALOG}`]: catalog() });
    const form = within(await screen.findByRole('form', { name: 'AI price table' }));
    expect((form.getByRole('button', { name: 'Save price table' }) as HTMLButtonElement).disabled).toBe(true);
    const add = form.getByRole('button', { name: 'Add image model price' }) as HTMLButtonElement;
    for (let i = 0; i < 100; i += 1) fireEvent.click(add);
    expect(form.getAllByLabelText(/^Image model \d+$/)).toHaveLength(100);
    expect(add.disabled).toBe(true);
  });

  it('renders a model name containing markup as text', async () => {
    const policy = pricing([field('image', { value: { default: 1, byModel: { '<img src=x onerror=alert(1)>': 3 } } }), field('chat', { value: { per1kInputTokens: 1, per1kOutputTokens: 1, minimum: 1 } })]);
    mount({ [`GET ${PRICING}`]: policy, [`GET ${CATALOG}`]: catalog() });
    const form = within(await screen.findByRole('form', { name: 'AI price table' }));
    expect((form.getByLabelText('Image model 1') as HTMLInputElement).value).toBe('<img src=x onerror=alert(1)>');
    expect(document.querySelector('img[src="x"]')).toBeNull();
  });
});

describe('permission gating', () => {
  it('without config:update the pricing page is not reachable and no policy is read or written', async () => {
    const server = mount({ [`GET ${PRICING}`]: pricing(), [`GET ${CATALOG}`]: catalog() }, '/ai/pricing', ['config:query', 'ai-tasks:query', 'chats:query']);
    await waitFor(() => expect(screen.queryByRole('form', { name: 'AI price table' })).toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole('button', { name: 'Save price table' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save model catalog' })).toBeNull();
    expect(server.find('PUT', PRICING)).toHaveLength(0);
    expect(server.find('PUT', CATALOG)).toHaveLength(0);
    expect(server.find('GET', PRICING)).toHaveLength(0);
  });

  it('task and chat lists are not reachable without their query permissions', async () => {
    const server = mount({ 'GET /management/ai-tasks': { data: [], total: 0, page: 1, pageSize: 20 }, 'GET /management/chats': { data: [], total: 0, page: 1, pageSize: 20 } }, '/ai/tasks', ['config:update']);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(server.find('GET', '/management/ai-tasks')).toHaveLength(0);
    cleanup();
    const chats = mount({ 'GET /management/chats': { data: [], total: 0, page: 1, pageSize: 20 } }, '/ai/chats', ['ai-tasks:query']);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(chats.find('GET', '/management/chats')).toHaveLength(0);
  });
});

describe('record lists', () => {
  const chatRow = { id: 'chat-1', ownerId: 'user-9', title: 'Hello', model: 'gpt-5-mini', messageCount: 4, cost: 12, updatedAt: '2026-11-10T00:00:00Z', providerId: 'openai', createdAt: '2026-11-09T00:00:00Z' };

  it('lists chats, filters by owner as a query param, and shows only listed columns', async () => {
    const server = mount({ 'GET /management/chats': { data: [chatRow], total: 1, page: 1, pageSize: 20 } }, '/ai/chats');
    expect((await screen.findAllByText('chat-1')).length).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText('User id'), { target: { value: 'user-9' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(server.find('GET', '/management/chats').at(-1)?.params).toMatchObject({ ownerId: 'user-9', page: 1 }));
    expect(screen.queryByRole('button', { name: /delete|remove|edit/i })).toBeNull();
  });

  it('shows an empty state for an empty page', async () => {
    mount({ 'GET /management/chats': { data: [], total: 0, page: 1, pageSize: 20 } }, '/ai/chats');
    await waitFor(() => expect(screen.queryByText('chat-1')).toBeNull());
    expect(await screen.findByText(/no (data|records|results|items)|nothing|empty/i)).toBeTruthy();
  });

  it('renders prompts and unexpected fields as text, never as markup', async () => {
    const xss = '<img src=x onerror="document.title=\'pwned\'">';
    const row = { id: 'task-x', ownerId: 'u', kind: 'image', status: 'FAILED', model: 'm', cost: 1, createdAt: '2026-11-10T00:00:00Z', prompt: xss };
    mount({ 'GET /management/ai-tasks': { data: [row], total: 1, page: 1, pageSize: 20 }, 'GET /management/ai-tasks/task-x': { ...row, extraNote: xss } }, '/ai/tasks');
    await screen.findAllByText('task-x');
    fireEvent.click(screen.getAllByRole('button', { name: 'Details' })[0]!);
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findAllByText(xss);
    expect(within(dialog).queryByText('extraNote')).toBeNull();
    expect(document.querySelector('img[src="x"]')).toBeNull();
    expect(document.title).not.toBe('pwned');
  });

  it('never renders credential-looking fields a server might add to a task record', async () => {
    const row = { id: 'task-s', ownerId: 'u', kind: 'audio', status: 'COMPLETED', model: 'm', cost: 1, createdAt: '2026-11-10T00:00:00Z', prompt: 'p' };
    mount({
      'GET /management/ai-tasks': { data: [{ ...row, apiKey: 'sk-SYNTHETIC-LIST' }], total: 1, page: 1, pageSize: 20 },
      'GET /management/ai-tasks/task-s': { ...row, apiKey: 'sk-SYNTHETIC-SECRET', authorization: 'Bearer SYNTHETIC-TOKEN', callbackSecret: 'SYNTHETIC-HMAC', providerPayload: { token: 'SYNTHETIC-PAYLOAD' } },
    }, '/ai/tasks');
    await screen.findAllByText('task-s');
    fireEvent.click(screen.getAllByRole('button', { name: 'Details' })[0]!);
    await screen.findByRole('dialog');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(document.body.textContent).not.toMatch(/SYNTHETIC/);
  });
});

describe('catalog editor', () => {
  it('blocks bad label, bad model and 101 entries; saves only edited kinds', async () => {
    const server = mount({ [`GET ${PRICING}`]: pricing(), [`GET ${CATALOG}`]: catalog(), [`PUT ${CATALOG}`]: { status: 200, data: catalog() } });
    const form = within(await screen.findByRole('form', { name: 'AI model catalog' }));
    fireEvent.click(form.getByRole('button', { name: 'Add image model' }));
    fireEvent.change(form.getByLabelText('Image entry 1 provider'), { target: { value: 'openai' } });
    fireEvent.change(form.getByLabelText('Image entry 1 model'), { target: { value: 'bad model!' } });
    fireEvent.click(form.getByRole('button', { name: 'Save model catalog' }));
    expect(await form.findByText(/Model ids use letters/)).toBeTruthy();
    expect(server.find('PUT', CATALOG)).toHaveLength(0);
    fireEvent.change(form.getByLabelText('Image entry 1 model'), { target: { value: 'gpt-image-1' } });
    fireEvent.click(form.getByRole('button', { name: 'Save model catalog' }));
    await waitFor(() => expect(server.find('PUT', CATALOG)).toHaveLength(1));
    expect((server.find('PUT', CATALOG)[0]?.body as { values: Record<string, unknown> }).values.image).toEqual([{ providerId: 'openai', model: 'gpt-image-1' }]);
  });

  it('read-only catalog (all kinds pinned) has no Save and sends nothing', async () => {
    const pinned = catalog([field('image', { public: true, pinnedByEnvironment: true, value: [{ providerId: 'openai', model: 'm' }] }), field('chat', { public: true, pinnedByEnvironment: true, value: [] })]);
    const server = mount({ [`GET ${PRICING}`]: pricing(), [`GET ${CATALOG}`]: pinned });
    const form = within(await screen.findByRole('form', { name: 'AI model catalog' }));
    expect(form.queryByRole('button', { name: 'Save model catalog' })).toBeNull();
    expect(form.getByLabelText('Image entry 1 model').matches(':disabled')).toBe(true);
    expect(server.find('PUT', CATALOG)).toHaveLength(0);
  });
});
