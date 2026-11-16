import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accountPublicClient, accountSession, accountRequestSignal } from '../src/lib/account-session';
import { httpClient } from '../src/lib/http-client';
import { readCreditBalance, shellClient } from '../src/lib/site/session';
import { AUTH_STORAGE_KEY, authSummary, useAuthStore } from '../src/lib/stores/auth-store';
import { establishSession } from '../src/app/[locale]/account/_components/sign-in';
import { acceptOAuthLogin } from '../src/app/[locale]/account/_components/oauth-client';

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
// Mock only the cookie network exchange. Actual stores, session guards and HTTP clients run below.
vi.mock('@zucker-framework/fe-http-client', async (original) => ({
  ...await original<typeof import('@zucker-framework/fe-http-client')>(),
  createCookieRefresh: () => refresh,
}));

const token = (sub: string, sid = `session-${sub}`, version = 1) => `h.${btoa(JSON.stringify({ sub, sid, version }))}.s`;
const alice = { id: 'alice', username: 'alice' };
const bob = { id: 'bob', username: 'bob' };

function signInAs(user = alice) {
  authSummary.allowIdentityChange();
  useAuthStore.getState().setAuthState({ token: token(user.id), user, permissions: ['account:read'] });
}

beforeEach(() => {
  localStorage.clear();
  refresh.mockReset();
  signInAs();
});
afterEach(() => {
  useAuthStore.getState().logout();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Web session identity across the main and shell clients', () => {
  it.each([['shell', shellClient], ['main', httpClient]] as const)('%s refuses another account from the shared refresh cookie', async (_name, client) => {
    refresh.mockResolvedValue({ access_token: token('bob') });
    let requests = 0;
    client.getAxiosInstance().defaults.adapter = async config => {
      requests += 1;
      expect(config.headers.get('Authorization')).toBe(`Bearer ${token('alice')}`);
      throw Object.assign(new Error('expired'), { config, response: { status: 401, config, data: { message: 'expired' } } });
    };
    // /login avoids JSDOM navigation while exercising the main client's actual unauthorized branch.
    window.history.replaceState(null, '', '/login');
    await expect(client.get('/credits/balance')).rejects.toMatchObject({ status: 401 });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(requests).toBe(1);
    expect(useAuthStore.getState()).toMatchObject({ token: null, user: null, isAuthenticated: false });
  });

  it('accepts credential rotation within the same session and retries with that token', async () => {
    const rotated = token('alice', 'session-alice', 2);
    refresh.mockResolvedValue({ access_token: rotated });
    shellClient.getAxiosInstance().defaults.adapter = async config => {
      if (config.headers.get('Authorization') !== `Bearer ${rotated}`)
        throw Object.assign(new Error('expired'), { config, response: { status: 401, config, data: {} } });
      return { config, status: 200, statusText: 'OK', headers: {}, data: { available: 123 } };
    };
    expect(await readCreditBalance()).toBe(123);
    expect(useAuthStore.getState()).toMatchObject({ token: rotated, user: alice });
  });

  it('drops a stale tab on a storage account switch without erasing the other tab account', () => {
    const other = JSON.stringify({ state: { token: token('bob'), user: bob, isAuthenticated: true, permissions: [] }, version: 0 });
    localStorage.setItem(AUTH_STORAGE_KEY, other);
    window.dispatchEvent(new StorageEvent('storage', { key: AUTH_STORAGE_KEY, newValue: other }));
    expect(useAuthStore.getState()).toMatchObject({ token: null, user: null, isAuthenticated: false });
    expect(localStorage.getItem(AUTH_STORAGE_KEY)).toBe(other);
  });

  it('aborts old account requests and streams instead of replaying a late mutation for the new account', async () => {
    let fail!: () => void;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const stream = accountRequestSignal(new AbortController().signal)!;
    const adapter = vi.fn(config => new Promise<never>((_resolve, reject) => {
      fail = () => reject(Object.assign(new Error('expired'), { config, response: { status: 401, config, data: {} } }));
      started();
    }));
    shellClient.getAxiosInstance().defaults.adapter = adapter;
    const pending = shellClient.post('/inbox/read-all', {});
    const rejected = expect(pending).rejects.toMatchObject({ code: 'ERR_CANCELED' });
    await ready;
    signInAs(bob);
    fail();
    await rejected;
    expect(stream.aborted).toBe(true);
    expect(adapter).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
    expect(useAuthStore.getState()).toMatchObject({ token: token('bob'), user: bob });
  });

  it('adopts an explicit login atomically and lets OAuth use the same flow', async () => {
    const seen: unknown[] = [];
    const unsubscribe = useAuthStore.subscribe(state => seen.push([state.user?.id, state.token]));
    accountPublicClient.getAxiosInstance().defaults.adapter = async config => {
      expect(config.headers.get('Authorization')).toBe(`Bearer ${token('bob')}`);
      expect(useAuthStore.getState().user?.id).toBe('alice');
      return { config, status: 200, statusText: 'OK', headers: {}, data: { ...bob, permissions: [{ id: 'billing', actions: ['query'] }] } };
    };
    await establishSession(token('bob'));
    unsubscribe();
    expect(seen).toEqual([['bob', token('bob')]]);
    expect(useAuthStore.getState().permissions).toEqual(['billing:query']);
    signInAs();
    expect(await acceptOAuthLogin({ token: token('bob'), returnPath: '/account' })).toBe('/account');
    expect(useAuthStore.getState()).toMatchObject({ user: bob, token: token('bob') });
    expect(refresh).not.toHaveBeenCalled();
  });

  it('does not install a partial identity or cookie-refresh after a refused explicit sign-in', async () => {
    accountPublicClient.getAxiosInstance().defaults.adapter = async config => {
      throw Object.assign(new Error('invalid login'), { config, response: { status: 401, config, data: {} } });
    };
    await expect(establishSession(token('bob'))).rejects.toMatchObject({ status: 401 });
    expect(useAuthStore.getState()).toMatchObject({ user: alice, token: token('alice') });
    expect(refresh).not.toHaveBeenCalled();
    expect(accountSession.needsRestore()).toBe(false);
  });
});
