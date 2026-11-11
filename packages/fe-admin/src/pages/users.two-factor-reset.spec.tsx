import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMockServer, meResponse, renderAdmin } from '../test/harness';

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(cleanup);

const resetUrl = '/management/users/u1/two-factor/reset';
function server(reset: unknown) {
  return createMockServer({
    'GET /menu/tree': [],
    'GET /authorize/me': meResponse(['*']),
    'POST /users/_query': { data: [{ id: 'u1', username: 'alice', email: 'alice@example.test', status: true }], total: 1 },
    [`POST ${resetUrl}`]: reset,
  });
}
const users = { twoFactorResetPath: '/management/users/:id/two-factor/reset' };

describe('staff two-factor reset', () => {
  it('is hidden unless the application configures the reset endpoint', async () => {
    const mock = server({ reset: true });
    renderAdmin({ httpAdapter: mock.adapter as never }, { path: '/users', permissions: ['*'] });
    await screen.findAllByRole('button', { name: '分配角色' });
    expect(screen.queryByRole('button', { name: '重置两步验证' })).toBeNull();
  });

  it('sends the operator password only and closes on success', async () => {
    const mock = server({ reset: true });
    renderAdmin({ httpAdapter: mock.adapter as never, users }, { path: '/users', permissions: ['*'] });
    fireEvent.click((await screen.findAllByRole('button', { name: '重置两步验证' }))[0]!);
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/你的密码/), { target: { value: 'operator-secret' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '重置' }));
    await waitFor(() => expect(mock.find('POST', resetUrl)).toHaveLength(1));
    expect(mock.find('POST', resetUrl)[0]!.body).toEqual({ password: 'operator-secret' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('shows the server refusal by code and keeps the dialog open', async () => {
    const mock = server({ status: 409, data: { status: 409, code: 'TWO_FACTOR_NOT_ENABLED', message: 'off', result: { reason: 'TWO_FACTOR_NOT_ENABLED' } } });
    renderAdmin({ httpAdapter: mock.adapter as never, users }, { path: '/users', permissions: ['*'] });
    fireEvent.click((await screen.findAllByRole('button', { name: '重置两步验证' }))[0]!);
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '重置' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe('此账户未开启两步验证');
    expect(mock.find('POST', resetUrl)[0]!.body).toEqual({});
  });
});
