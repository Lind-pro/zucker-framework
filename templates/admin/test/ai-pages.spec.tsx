/**
 * Component tests for the AI back-office pages (features/ai): typed price/catalog editors over the
 * `ai-pricing` / `ai-catalog` policies and the read-only task list.
 */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMockServer, renderAdmin } from '../../../packages/fe-admin/src/test/harness';
import { aiPages, parseMediaPrice, mediaPriceDraft, policyLayout } from '../src/features/ai';

const locales = { 'zh-CN': { label: '中文', messages: {} }, 'en-US': { label: 'English', messages: {} } };
const PRICING = '/management/policies/ai-pricing';
const CATALOG = '/management/policies/ai-catalog';

const pricing = (over: Record<string, unknown> = {}) => ({
  id: 'ai-pricing',
  name: 'AI pricing',
  revision: 3,
  fields: [
    { key: 'image', type: 'json', default: { default: 2, byModel: {} }, value: { default: 2, byModel: { 'gpt-image-1': 5 } } },
    { key: 'video', type: 'json', default: { default: 20, byModel: {} }, value: { default: 20, byModel: {} }, pinnedByEnvironment: true },
    { key: 'chat', type: 'json', default: { per1kInputTokens: 0.5, per1kOutputTokens: 1.5, minimum: 1 } },
  ],
  ...over,
});
const catalog = (over: Record<string, unknown> = {}) => ({
  id: 'ai-catalog',
  name: 'AI catalog',
  revision: 1,
  fields: [
    { key: 'image', type: 'json', public: true, default: [], value: [{ providerId: 'openai', model: 'gpt-image-1', label: 'GPT Image' }] },
    { key: 'chat', type: 'json', public: true, default: [] },
  ],
  ...over,
});

function mount(routes: Record<string, unknown>, path = '/ai/pricing', permissions = ['config:query', 'config:update', 'ai-tasks:query', 'chats:query']) {
  const server = createMockServer({ 'GET /menu/tree': [], ...routes });
  renderAdmin({ httpAdapter: server.adapter as never, locales, extraPages: aiPages }, { path, permissions });
  return server;
}
const priceForm = () => screen.findByRole('form', { name: 'AI price table' });

beforeEach(() => localStorage.setItem('zucker-admin-locale', 'en-US'));
afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('AI pricing editor', () => {
  it('blocks invalid credits and duplicate models, then saves only editable kinds with expectedRevision', async () => {
    const saved = pricing({ revision: 4 });
    const server = mount({ [`GET ${PRICING}`]: pricing(), [`GET ${CATALOG}`]: catalog(), [`PUT ${PRICING}`]: { status: 200, data: saved } });
    const form = within(await priceForm());
    expect((form.getByLabelText('Image model 1') as HTMLInputElement).value).toBe('gpt-image-1');
    expect((form.getByLabelText('Credits per 1k input tokens') as HTMLInputElement).value).toBe('0.5');
    // Pinned kind is locked.
    expect(form.getByLabelText('Video: default credits per task').matches(':disabled')).toBe(true);

    fireEvent.click(form.getByRole('button', { name: 'Add image model price' }));
    fireEvent.change(form.getByLabelText('Image model 2'), { target: { value: 'gpt-image-1' } });
    fireEvent.change(form.getByLabelText('Image model 2 credits'), { target: { value: '1.5' } });
    fireEvent.change(form.getByLabelText('Minimum credits per message'), { target: { value: '-1' } });
    fireEvent.click(form.getByRole('button', { name: 'Save price table' }));
    expect(await form.findByText('Duplicates an entry above')).toBeTruthy();
    expect(form.getAllByText('Enter a whole number of 0 or more')).toHaveLength(2);
    expect(server.find('PUT', PRICING)).toHaveLength(0);

    fireEvent.change(form.getByLabelText('Image model 2'), { target: { value: 'flux/schnell' } });
    fireEvent.change(form.getByLabelText('Image model 2 credits'), { target: { value: '3' } });
    fireEvent.change(form.getByLabelText('Minimum credits per message'), { target: { value: '2' } });
    fireEvent.change(form.getByLabelText('Credits per 1k output tokens'), { target: { value: '0.125' } });
    fireEvent.click(form.getByRole('button', { name: 'Save price table' }));
    await waitFor(() => expect(server.find('PUT', PRICING)).toHaveLength(1));
    const body = server.find('PUT', PRICING)[0]?.body as { expectedRevision: number; values: Record<string, unknown> };
    expect(body.expectedRevision).toBe(3);
    expect(body.values).toEqual({
      image: { default: 2, byModel: { 'gpt-image-1': 5, 'flux/schnell': 3 } },
      chat: { per1kInputTokens: 0.5, per1kOutputTokens: 0.125, minimum: 2 },
    });
    expect(await screen.findByText('Revision 4')).toBeTruthy();
  });

  it('offers catalog models as suggestions and reports a 409 with a reload', async () => {
    const latest = pricing({ revision: 9 });
    const server = mount({ [`GET ${PRICING}`]: pricing(), [`GET ${CATALOG}`]: catalog(), [`PUT ${PRICING}`]: { status: 409, data: { message: 'stale' } } });
    const form = within(await priceForm());
    expect(document.querySelector('datalist option[value="gpt-image-1"]')).toBeTruthy();
    fireEvent.change(form.getByLabelText('Image: default credits per task'), { target: { value: '7' } });
    fireEvent.click(form.getByRole('button', { name: 'Save price table' }));
    expect(await screen.findByText('This policy was changed elsewhere')).toBeTruthy();
    expect(form.getByLabelText('Image: default credits per task').matches(':disabled')).toBe(true);
    server.set(`GET ${PRICING}`, latest);
    const notice = screen.getByText('This policy was changed elsewhere').closest('[role]') ?? document.body;
    fireEvent.click(within(notice as HTMLElement).getByRole('button', { name: 'Reload' }));
    expect(await screen.findByText('Revision 9')).toBeTruthy();
    expect(within(await priceForm()).getByLabelText('Image: default credits per task').matches(':disabled')).toBe(false);
  });

  it('shows a notice when the server does not register the policies', async () => {
    mount({ [`GET ${PRICING}`]: { status: 404, data: {} }, [`GET ${CATALOG}`]: { status: 404, data: {} } });
    expect(await screen.findByText('The server does not register the ai-pricing policy')).toBeTruthy();
    expect(screen.getByText('The server does not register the ai-catalog policy')).toBeTruthy();
  });
});

describe('AI catalog editor', () => {
  it('rejects duplicate provider/model pairs and bad provider ids', async () => {
    const server = mount({ [`GET ${PRICING}`]: pricing(), [`GET ${CATALOG}`]: catalog(), [`PUT ${CATALOG}`]: { status: 200, data: catalog({ revision: 2 }) } });
    const form = within(await screen.findByRole('form', { name: 'AI model catalog' }));
    fireEvent.click(form.getByRole('button', { name: 'Add image model' }));
    expect((form.getByLabelText('Image entry 2 provider') as HTMLInputElement).value).toBe('openai');
    fireEvent.change(form.getByLabelText('Image entry 2 model'), { target: { value: 'gpt-image-1' } });
    fireEvent.click(form.getByRole('button', { name: 'Add chat model' }));
    fireEvent.change(form.getByLabelText('Chat entry 1 provider'), { target: { value: 'Open AI' } });
    fireEvent.change(form.getByLabelText('Chat entry 1 model'), { target: { value: 'gpt-5-mini' } });
    fireEvent.click(form.getByRole('button', { name: 'Save model catalog' }));
    expect(await form.findByText('Duplicates an entry above')).toBeTruthy();
    expect(form.getByText('Provider ids use lowercase letters, digits, - and _')).toBeTruthy();
    expect(server.find('PUT', CATALOG)).toHaveLength(0);

    fireEvent.change(form.getByLabelText('Image entry 2 model'), { target: { value: 'dall-e-3' } });
    fireEvent.change(form.getByLabelText('Chat entry 1 provider'), { target: { value: 'openai' } });
    fireEvent.click(form.getByRole('button', { name: 'Save model catalog' }));
    await waitFor(() => expect(server.find('PUT', CATALOG)).toHaveLength(1));
    expect((server.find('PUT', CATALOG)[0]?.body as { values: unknown }).values).toEqual({
      image: [
        { providerId: 'openai', model: 'gpt-image-1', label: 'GPT Image' },
        { providerId: 'openai', model: 'dall-e-3' },
      ],
      chat: [{ providerId: 'openai', model: 'gpt-5-mini' }],
    });
  });
});

describe('AI task list', () => {
  it('lists tasks with filters as query params and opens a fresh detail read', async () => {
    const row = { id: 'task-1', ownerId: 'user-1', kind: 'image', status: 'COMPLETED', model: 'gpt-image-1', cost: 5, createdAt: '2026-11-10T00:00:00Z', prompt: 'a cat' };
    const server = mount({
      'GET /management/ai-tasks': { data: [row], total: 1, page: 1, pageSize: 20 },
      'GET /management/ai-tasks/task-1': { ...row, outputCount: 2, errorCode: null, providerTaskState: 'done' },
    }, '/ai/tasks');
    expect((await screen.findAllByText('task-1')).length).toBeGreaterThan(0);
    expect(server.find('GET', '/management/ai-tasks')[0]?.params).toMatchObject({ page: 1, pageSize: 20 });
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'FAILED' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(server.find('GET', '/management/ai-tasks').at(-1)?.params).toMatchObject({ status: 'FAILED', page: 1 }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Details' })[0]!);
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('a cat')).toBeTruthy();
    // Undeclared fields are never rendered (allow-list).
    expect(within(dialog).queryByText('providerTaskState')).toBeNull();
    expect(server.find('GET', '/management/ai-tasks/task-1')).toHaveLength(1);
  });
});

describe('pricing model', () => {
  it('accepts the single-field layout and keeps unknown keys', () => {
    const layout = policyLayout(
      { id: 'ai-pricing', revision: 1, fields: [{ key: 'table', type: 'json', value: { image: { default: 1, byModel: {} }, future: true } }] },
      ['image', 'chat'],
    );
    expect(layout?.slots.map((slot) => slot.kind)).toEqual(['image', 'chat']);
    expect(layout?.write({ image: { default: 4, byModel: {} } })).toEqual({ table: { image: { default: 4, byModel: {} }, future: true } });
    const parsed = parseMediaPrice({ ...mediaPriceDraft({ default: 3, byModel: { a: 1 }, note: 'x' }) });
    expect(parsed.value).toEqual({ note: 'x', default: 3, byModel: { a: 1 } });
    expect(parseMediaPrice(mediaPriceDraft({ default: 2147483648 })).issues).toEqual({ default: 'tooLarge' });
  });
});
