import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveConfig } from '../app/config';
import { createMockServer, meResponse, renderAdmin, type MockRequest } from '../test/harness';

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(cleanup);

const alice = { id: 'u1', username: 'alice', email: 'alice@example.test', name: 'Alice', status: true, typeId: 'member' };
const typeOptions = [
  { value: 'member', label: { 'zh-CN': '普通用户', 'en-US': 'Member' } },
  { value: 'admin', label: '管理员' },
];

function server(extra: Record<string, unknown> = {}) {
  return createMockServer({
    'GET /menu/tree': [],
    'GET /authorize/me': meResponse(['*']),
    'POST /users/_query': { data: [alice], total: 1 },
    'POST /users': ({ body }: MockRequest) => ({ data: { id: 'u2', ...(body as object) } }),
    'PUT /users/u1': ({ body }: MockRequest) => ({ data: { ...alice, ...(body as object) } }),
    ...extra,
  });
}

describe('users.typeOptions', () => {
  it('keeps the type out of the page when not configured', async () => {
    const mock = server();
    renderAdmin({ httpAdapter: mock.adapter as never }, { path: '/users', permissions: ['*'] });
    const table = await screen.findByRole('table', { name: '用户' });
    expect(within(table).queryByText('账户类型')).toBeNull();
    fireEvent.click(within(table).getByRole('button', { name: '编辑' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByLabelText(/账户类型/)).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(mock.find('PUT', '/users/u1')).toHaveLength(1));
    expect(mock.find('PUT', '/users/u1')[0]!.body).not.toHaveProperty('typeId');
  });

  it('shows the type, defaults creation to createDefaults.typeId and sends a changed type only', async () => {
    const mock = server();
    renderAdmin(
      { httpAdapter: mock.adapter as never, users: { typeOptions, createDefaults: { typeId: 'member', source: 'admin' } } },
      { path: '/users', permissions: ['*'] },
    );
    const table = await screen.findByRole('table', { name: '用户' });
    expect(await within(table).findByText('普通用户')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '新建用户' }));
    const create = await screen.findByRole('dialog');
    expect((within(create).getByLabelText(/账户类型/) as HTMLSelectElement).value).toBe('member');
    fireEvent.change(within(create).getByLabelText(/用户名/), { target: { value: 'bob' } });
    fireEvent.change(within(create).getByLabelText(/邮箱/), { target: { value: 'bob@example.test' } });
    fireEvent.change(within(create).getByLabelText(/^密码/), { target: { value: 'synthetic-pass' } });
    fireEvent.change(within(create).getByLabelText(/账户类型/), { target: { value: 'admin' } });
    fireEvent.click(within(create).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(mock.find('POST', '/users')).toHaveLength(1));
    expect(mock.find('POST', '/users')[0]!.body).toMatchObject({ source: 'admin', typeId: 'admin', username: 'bob' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fireEvent.click(within(table).getByRole('button', { name: '编辑' }));
    const edit = await screen.findByRole('dialog');
    fireEvent.click(within(edit).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(mock.find('PUT', '/users/u1')).toHaveLength(1));
    expect(mock.find('PUT', '/users/u1')[0]!.body).not.toHaveProperty('typeId');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fireEvent.click(within(table).getByRole('button', { name: '编辑' }));
    const change = await screen.findByRole('dialog');
    fireEvent.change(within(change).getByLabelText(/账户类型/), { target: { value: 'admin' } });
    fireEvent.click(within(change).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(mock.find('PUT', '/users/u1')).toHaveLength(2));
    expect(mock.find('PUT', '/users/u1')[1]!.body).toMatchObject({ typeId: 'admin' });
  });

  it('disables changing the type of an existing account without users:authorize', async () => {
    const mock = server();
    renderAdmin({ httpAdapter: mock.adapter as never, users: { typeOptions } }, { path: '/users', permissions: ['users:query', 'users:update'] });
    const table = await screen.findByRole('table', { name: '用户' });
    fireEvent.click(await within(table).findByRole('button', { name: '编辑' }));
    const dialog = await screen.findByRole('dialog');
    expect((within(dialog).getByLabelText(/账户类型/) as HTMLSelectElement).disabled).toBe(true);
  });
});

describe('users.passwordReset', () => {
  const passwordReset = { path: '/users/:id', method: 'PUT' as const, minLength: 8 };

  it('is hidden without configuration and without users:authorize', async () => {
    const mock = server();
    renderAdmin({ httpAdapter: mock.adapter as never }, { path: '/users', permissions: ['*'] });
    await screen.findAllByRole('button', { name: '分配角色' });
    expect(screen.queryByRole('button', { name: '重置密码' })).toBeNull();
    cleanup();

    const limited = server();
    renderAdmin({ httpAdapter: limited.adapter as never, users: { passwordReset } }, { path: '/users', permissions: ['users:query', 'users:update'] });
    await screen.findAllByRole('button', { name: '编辑' });
    expect(screen.queryByRole('button', { name: '重置密码' })).toBeNull();
  });

  it('validates locally, then sends only the new password with the configured method', async () => {
    const mock = server();
    renderAdmin({ httpAdapter: mock.adapter as never, users: { passwordReset } }, { path: '/users', permissions: ['*'] });
    fireEvent.click((await screen.findAllByRole('button', { name: '重置密码' }))[0]!);
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/^新密码/), { target: { value: 'short' } });
    fireEvent.change(within(dialog).getByLabelText(/确认新密码/), { target: { value: 'other' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '重置密码' }));
    expect(await within(dialog).findByText('密码至少需要 8 个字符')).toBeTruthy();
    expect(within(dialog).getByText('两次输入的密码不一致')).toBeTruthy();
    expect(mock.find('PUT', '/users/u1')).toHaveLength(0);

    fireEvent.change(within(dialog).getByLabelText(/^新密码/), { target: { value: 'synthetic-pass-1' } });
    fireEvent.change(within(dialog).getByLabelText(/确认新密码/), { target: { value: 'synthetic-pass-1' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '重置密码' }));
    await waitFor(() => expect(mock.find('PUT', '/users/u1')).toHaveLength(1));
    expect(mock.find('PUT', '/users/u1')[0]!.body).toEqual({ password: 'synthetic-pass-1' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('keeps the input after a server refusal (default POST)', async () => {
    const mock = server({ 'POST /admin/users/u1/reset-password': { status: 400, data: { status: 400, message: 'Invalid password' } } });
    renderAdmin(
      { httpAdapter: mock.adapter as never, users: { passwordReset: { path: '/admin/users/:id/reset-password' } } },
      { path: '/users', permissions: ['*'] },
    );
    fireEvent.click((await screen.findAllByRole('button', { name: '重置密码' }))[0]!);
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/^新密码/), { target: { value: 'x' } });
    fireEvent.change(within(dialog).getByLabelText(/确认新密码/), { target: { value: 'x' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '重置密码' }));
    expect(await within(dialog).findByText(/重置失败，输入已保留/)).toBeTruthy();
    expect((within(dialog).getByLabelText(/^新密码/) as HTMLInputElement).value).toBe('x');
  });

  it('rejects a reset path without :id or an unknown method', () => {
    expect(() => resolveConfig({ users: { passwordReset: { path: '/users/reset' } } })).toThrow(/:id/);
    expect(() => resolveConfig({ users: { passwordReset: { path: '/users/:id', method: 'DELETE' as never } } })).toThrow(/method/);
    expect(resolveConfig({ users: { passwordReset: { path: '/users/:id' } } }).usersPasswordReset).toEqual({ path: '/users/:id', method: 'POST' });
  });
});

describe('users status filter', () => {
  it('filters by exact status', async () => {
    const mock = server();
    renderAdmin({ httpAdapter: mock.adapter as never }, { path: '/users', permissions: ['*'] });
    await screen.findByRole('table', { name: '用户' });
    const search = screen.getByRole('search');
    fireEvent.change(within(search).getByLabelText('状态'), { target: { value: 'false' } });
    fireEvent.change(within(search).getByLabelText('用户名'), { target: { value: 'ali' } });
    fireEvent.click(within(search).getByRole('button', { name: '查询' }));
    await waitFor(() => expect(mock.find('POST', '/users/_query').length).toBeGreaterThan(1));
    expect(mock.find('POST', '/users/_query').at(-1)!.body).toMatchObject({ filter: { status: false, username$like: 'ali' } });
  });
});
