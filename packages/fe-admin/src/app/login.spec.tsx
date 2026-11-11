import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMockServer, meResponse, renderAdmin, testToken } from '../test/harness';

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(cleanup);

const token = testToken({ sub: 'admin-1', sid: 'session-1' });

function enterPassword() {
  fireEvent.change(screen.getByLabelText(/账号|用户名/), { target: { value: 'admin' } });
  fireEvent.change(screen.getByLabelText(/密码/), { target: { value: 'secret' } });
  fireEvent.click(screen.getByRole('button', { name: '登录' }));
}

describe('admin login two-factor step', () => {
  it('asks for a code after { twoFactorRequired } and completes with POST /authorize/login/two-factor', async () => {
    let attempts = 0;
    const server = createMockServer({
      'GET /menu/tree': [],
      'GET /authorize/me': meResponse(['*']),
      'POST /authorize/login': { twoFactorRequired: true, challenge: 'challenge-1' },
      'POST /authorize/login/two-factor': () => (++attempts === 1 ? { status: 401, data: { message: 'bad code' } } : { data: { token } }),
    });
    const { session, router } = renderAdmin({ httpAdapter: server.adapter as never }, { path: '/login' });
    await screen.findByRole('heading', { name: '登录管理后台' });
    enterPassword();

    const code = await screen.findByLabelText(/验证码/);
    expect(session.store.getState().token).toBeNull();
    fireEvent.change(code, { target: { value: '123 456' } });
    fireEvent.click(screen.getByRole('button', { name: '验证并登录' }));
    expect(await screen.findByText(/验证未通过/)).toBeTruthy();

    // Wrong code keeps the challenge; switch to a recovery code.
    fireEvent.click(screen.getByRole('button', { name: '改用恢复码' }));
    fireEvent.change(await screen.findByLabelText(/恢复码/), { target: { value: 'abcde-fghjk' } });
    fireEvent.click(screen.getByRole('button', { name: '验证并登录' }));
    await waitFor(() => expect(session.store.getState().token).toBe(token));
    expect(server.find('POST', '/authorize/login/two-factor').map((call) => call.body)).toEqual([
      { challenge: 'challenge-1', code: '123456' },
      { challenge: 'challenge-1', recoveryCode: 'abcde-fghjk' },
    ]);
    await waitFor(() => expect(router.state.location.pathname).not.toBe('/login'));
  });

  it('keeps the old flow for servers that never return the flag', async () => {
    const server = createMockServer({
      'GET /menu/tree': [],
      'GET /authorize/me': meResponse(['*']),
      'POST /authorize/login': { token },
    });
    const { session } = renderAdmin({ httpAdapter: server.adapter as never }, { path: '/login' });
    await screen.findByRole('heading', { name: '登录管理后台' });
    enterPassword();
    await waitFor(() => expect(session.store.getState().token).toBe(token));
    expect(server.find('POST', '/authorize/login/two-factor')).toHaveLength(0);
  });
});

describe('admin login identifier option', () => {
  it('email: labels an email input and posts { email, password }', async () => {
    const server = createMockServer({
      'GET /menu/tree': [],
      'GET /authorize/me': meResponse(['*']),
      'POST /authorize/login': { token },
    });
    const { session } = renderAdmin({ httpAdapter: server.adapter as never, login: { identifier: 'email' } }, { path: '/login' });
    await screen.findByText('请输入邮箱和密码');
    const input = screen.getByLabelText(/邮箱/) as HTMLInputElement;
    expect(input.type).toBe('email');
    expect(input.name).toBe('email');
    expect(input.autocomplete).toBe('username');
    fireEvent.change(input, { target: { value: ' Admin@Example.Invalid ' } });
    fireEvent.change(screen.getByLabelText(/密码/), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: '登录' }));
    await waitFor(() => expect(session.store.getState().token).toBe(token));
    expect(server.find('POST', '/authorize/login').map((call) => call.body)).toEqual([{ email: 'Admin@Example.Invalid', password: 'secret' }]);
  });

  it('username-or-email: one text field posted as { login }', async () => {
    const server = createMockServer({
      'GET /menu/tree': [],
      'GET /authorize/me': meResponse(['*']),
      'POST /authorize/login': { token },
    });
    const { session } = renderAdmin({ httpAdapter: server.adapter as never, login: { identifier: 'username-or-email' } }, { path: '/login' });
    const input = (await screen.findByLabelText(/用户名或邮箱/)) as HTMLInputElement;
    expect(input.type).toBe('text');
    fireEvent.change(input, { target: { value: 'admin' } });
    fireEvent.change(screen.getByLabelText(/密码/), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: '登录' }));
    await waitFor(() => expect(session.store.getState().token).toBe(token));
    expect(server.find('POST', '/authorize/login').map((call) => call.body)).toEqual([{ login: 'admin', password: 'secret' }]);
  });

  it('username stays the default body', async () => {
    const server = createMockServer({ 'GET /menu/tree': [], 'GET /authorize/me': meResponse(['*']), 'POST /authorize/login': { token } });
    const { session } = renderAdmin({ httpAdapter: server.adapter as never }, { path: '/login' });
    await screen.findByRole('heading', { name: '登录管理后台' });
    expect((screen.getByLabelText(/用户名/) as HTMLInputElement).name).toBe('username');
    enterPassword();
    await waitFor(() => expect(session.store.getState().token).toBe(token));
    expect(server.find('POST', '/authorize/login').map((call) => call.body)).toEqual([{ username: 'admin', password: 'secret' }]);
  });
});
