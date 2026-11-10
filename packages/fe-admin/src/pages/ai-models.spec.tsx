import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMockServer, renderAdmin, type MockRequest } from '../test/harness';

const stored = {
  id: 'm1',
  name: 'Primary',
  provider: 'openai',
  modelId: 'gpt-synthetic',
  apiKey: 'sk-***',
  baseUrl: 'https://gateway.test/v1',
  temperature: 0.7,
  maxTokens: 512,
  isEnabled: true,
  isDefault: false,
  description: null,
  updatedAt: '2026-11-01T00:00:00.000Z',
};

async function openEditor() {
  const server = createMockServer({
    'GET /menu/tree': [],
    'GET /management/ai-models': { data: [stored], total: 1 },
    'PUT /management/ai-models/m1': ({ body }: MockRequest) => ({ data: { id: 'm1', ...(body as object) } }),
  });
  renderAdmin(
    { httpAdapter: server.adapter as never, ai: { providers: ['openai', 'deepseek'] } },
    { path: '/ai-models', permissions: ['ai-models:query', 'ai-models:update'] },
  );
  const table = await screen.findByRole('table', { name: 'AI 模型' });
  const edit = await within(table).findByRole('button', { name: '编辑' });
  await waitFor(() => expect((edit as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(edit);
  const dialog = await screen.findByRole('dialog');
  return { server, dialog };
}

describe('AIModelsPage editor', () => {
  beforeEach(() => localStorage.clear());
  afterEach(cleanup);

  it('sends null when a stored temperature or max tokens is cleared', async () => {
    const { server, dialog } = await openEditor();
    fireEvent.change(within(dialog).getByLabelText(/Temperature/), { target: { value: '' } });
    fireEvent.change(within(dialog).getByLabelText(/最大 Tokens/), { target: { value: '' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(server.find('PUT', '/management/ai-models/m1')).toHaveLength(1));
    const body = server.find('PUT', '/management/ai-models/m1')[0]!.body as Record<string, unknown>;
    expect(body).toHaveProperty('temperature', null);
    expect(body).toHaveProperty('maxTokens', null);
  });

  it('omits apiKey when the destination is unchanged and the key field is empty', async () => {
    const { server, dialog } = await openEditor();
    fireEvent.change(within(dialog).getByLabelText(/模型 ID/), { target: { value: 'gpt-synthetic-2' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(server.find('PUT', '/management/ai-models/m1')).toHaveLength(1));
    const body = server.find('PUT', '/management/ai-models/m1')[0]!.body as Record<string, unknown>;
    expect(body).not.toHaveProperty('apiKey');
    expect(body).toMatchObject({ modelId: 'gpt-synthetic-2', temperature: 0.7, maxTokens: 512 });
  });

  it('asks for the key and sends no PUT when the Base URL changes with an empty key', async () => {
    const { server, dialog } = await openEditor();
    fireEvent.change(within(dialog).getByLabelText(/Base URL/), { target: { value: 'https://other.test/v1' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));
    expect(await within(dialog).findByText('修改提供商或 Base URL 后必须重新填写 API Key')).toBeTruthy();
    expect(server.find('PUT', '/management/ai-models/m1')).toHaveLength(0);
  });

  it('asks for the key and sends no PUT when the provider changes with an empty key', async () => {
    const { server, dialog } = await openEditor();
    fireEvent.change(within(dialog).getByLabelText(/提供方/), { target: { value: 'deepseek' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));
    expect(await within(dialog).findByText('修改提供商或 Base URL 后必须重新填写 API Key')).toBeTruthy();
    expect(server.find('PUT', '/management/ai-models/m1')).toHaveLength(0);
  });

  it('sends the new key when the destination changes and a key is entered', async () => {
    const { server, dialog } = await openEditor();
    fireEvent.change(within(dialog).getByLabelText(/Base URL/), { target: { value: 'https://other.test/v1' } });
    fireEvent.change(within(dialog).getByLabelText(/^API Key/), { target: { value: 'sk-new' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(server.find('PUT', '/management/ai-models/m1')).toHaveLength(1));
    expect(server.find('PUT', '/management/ai-models/m1')[0]!.body).toMatchObject({
      apiKey: 'sk-new',
      baseUrl: 'https://other.test/v1',
    });
  });
});
