import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { enUS } from '../i18n/en-US';
import { zhCN } from '../i18n/zh-CN';
import { createMockServer, meResponse, renderAdmin, testToken } from '../test/harness';

const locales = { 'zh-CN': { label: '中文', messages: {} }, 'en-US': { label: 'English', messages: {} } };
const token = testToken({ sub: 'admin-1', sid: 'session-1' });

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  localStorage.setItem('zucker-admin-locale', 'en-US');
});
afterEach(cleanup);

describe('admin login in en-US', () => {
  it('two-factor and role-expiry strings exist in both locales', () => {
    const keys = Object.keys(zhCN).filter((key) => /^(shell\.(twoFactor|recovery|useRecovery|useAuthenticator)|roleAssign\.expire)/.test(key));
    expect(keys.length).toBeGreaterThanOrEqual(12);
    for (const key of keys) {
      expect((enUS as Record<string, string>)[key], key).toBeTruthy();
      expect((enUS as Record<string, string>)[key], key).not.toMatch(/[一-鿿]/);
    }
  });

  it('shows the English two-factor step, hides the challenge and never persists it', async () => {
    const server = createMockServer({
      'GET /menu/tree': [],
      'GET /authorize/me': meResponse(['*']),
      'POST /authorize/login': { twoFactorRequired: true, challenge: 'secret-challenge-xyz' },
      'POST /authorize/login/two-factor': { status: 401, data: { message: 'bad' } },
    });
    const { session } = renderAdmin({ httpAdapter: server.adapter as never, locales }, { path: '/login' });
    await screen.findByRole('heading', { name: 'Sign in to administration' });
    fireEvent.change(screen.getByLabelText(/Username/), { target: { value: 'admin' } });
    fireEvent.change(screen.getByLabelText(/Password/), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    const code = await screen.findByLabelText(/Authentication code/);
    expect(screen.getByText('Enter the 6-digit code from your authenticator app')).toBeTruthy();
    // The language switcher legitimately shows the native name of the Chinese locale; check the card.
    expect(document.querySelector('form')!.parentElement!.textContent).not.toMatch(/[一-鿿]/);
    expect(document.body.textContent).not.toContain('secret-challenge-xyz');

    // Too-short input is rejected locally and never reaches the server.
    fireEvent.change(code, { target: { value: '12' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify and sign in' }));
    expect(server.find('POST', '/authorize/login/two-factor')).toHaveLength(0);

    fireEvent.change(code, { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify and sign in' }));
    expect(await screen.findByText(/The code was not accepted/)).toBeTruthy();
    expect(session.store.getState().token).toBeNull();
    for (const storage of [localStorage, sessionStorage])
      expect(JSON.stringify({ ...storage })).not.toContain('secret-challenge-xyz');
    expect(window.location.href).not.toContain('secret-challenge-xyz');

    fireEvent.click(screen.getByRole('button', { name: 'Use a recovery code instead' }));
    expect(await screen.findByLabelText(/Recovery code/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Back to sign-in' }));
    expect(await screen.findByLabelText(/Username/)).toBeTruthy();
    expect(screen.queryByLabelText(/Authentication code/)).toBeNull();
  });

  it('a 2FA success after the challenge signs in without sending the password again', async () => {
    const server = createMockServer({
      'GET /menu/tree': [],
      'GET /authorize/me': meResponse(['*']),
      'POST /authorize/login': { twoFactorRequired: true, challenge: 'c1' },
      'POST /authorize/login/two-factor': { token },
    });
    const { session } = renderAdmin({ httpAdapter: server.adapter as never, locales }, { path: '/login' });
    await screen.findByRole('heading', { name: 'Sign in to administration' });
    fireEvent.change(screen.getByLabelText(/Username/), { target: { value: 'admin' } });
    fireEvent.change(screen.getByLabelText(/Password/), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    fireEvent.change(await screen.findByLabelText(/Authentication code/), { target: { value: '654321' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify and sign in' }));
    await waitFor(() => expect(session.store.getState().token).toBe(token));
    expect(JSON.stringify(server.find('POST', '/authorize/login/two-factor').map((c) => c.body))).not.toContain('secret');
    expect(server.find('POST', '/authorize/login')).toHaveLength(1);
  });
});
