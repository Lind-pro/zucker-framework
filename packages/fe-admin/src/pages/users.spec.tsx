import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMockServer, meResponse, renderAdmin } from '../test/harness';
import { expiryDateValue, expiryFromDateValue, parseRoleExpiries } from './users';

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(cleanup);

const role = { id: 'r1', name: 'editor' };

function server(rolesReply: Record<string, unknown>) {
  return createMockServer({
    'GET /menu/tree': [],
    'GET /authorize/me': meResponse(['*']),
    'POST /users/_query': { data: [{ id: 'u1', username: 'alice', email: 'alice@example.test', status: true }], total: 1 },
    'GET /users/u1/roles': rolesReply,
    'POST /roles/_query': { data: [role, { id: 'r2', name: 'viewer' }], total: 2 },
    'PUT /users/u1/roles': ({ body }: { body: unknown }) => ({ data: body }),
  });
}

async function openRoles() {
  fireEvent.click((await screen.findAllByRole('button', { name: '分配角色' }))[0]!);
  return screen.findByRole('dialog');
}

describe('user role expiry field', () => {
  it('is hidden and never sent when the server omits expiries', async () => {
    const mock = server({ roleIds: ['r1'], roles: [role] });
    renderAdmin({ httpAdapter: mock.adapter as never }, { path: '/users', permissions: ['*'] });
    const dialog = await openRoles();
    await within(dialog).findByRole('button', { name: '移除角色 editor' });
    expect(within(dialog).queryByLabelText(/到期日/)).toBeNull();
    fireEvent.click(await within(dialog).findByRole('checkbox', { name: /viewer/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: '保存角色' }));
    await waitFor(() => expect(mock.find('PUT', '/users/u1/roles')).toHaveLength(1));
    expect(mock.find('PUT', '/users/u1/roles')[0]!.body).toEqual({ roleIds: ['r1', 'r2'] });
  });

  it('edits and sends expiries when the server returns them', async () => {
    const mock = server({ roleIds: ['r1'], roles: [role], expiries: { r1: null } });
    renderAdmin({ httpAdapter: mock.adapter as never }, { path: '/users', permissions: ['*'] });
    const dialog = await openRoles();
    const input = await within(dialog).findByLabelText('角色 editor 的到期日');
    fireEvent.change(input, { target: { value: '2027-01-31' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存角色' }));
    await waitFor(() => expect(mock.find('PUT', '/users/u1/roles')).toHaveLength(1));
    expect(mock.find('PUT', '/users/u1/roles')[0]!.body).toEqual({
      roleIds: ['r1'],
      expiries: { r1: expiryFromDateValue('2027-01-31') },
    });
  });
});

describe('role expiry helpers', () => {
  it('round-trips a local date to an end-of-day instant', () => {
    const iso = expiryFromDateValue('2027-01-31')!;
    expect(expiryDateValue(iso)).toBe('2027-01-31');
    expect(expiryFromDateValue('')).toBeNull();
    expect(parseRoleExpiries({ r1: 'nonsense' })).toBeNull();
    expect(parseRoleExpiries(undefined)).toBeNull();
    expect(parseRoleExpiries({ r1: null })).toEqual({ r1: null });
  });
});
