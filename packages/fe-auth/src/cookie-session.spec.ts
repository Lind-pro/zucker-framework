import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAuthStore } from './store';
import { createCookieSession, createSessionSummaryStorage } from './cookie-session';
import { jwtSessionKey } from './session';

interface User {
  id: string;
  username: string;
}
const KEY = 'test-session';
const token = (sub: string, sid: string) => `h.${btoa(JSON.stringify({ sub, sid })).replace(/=+$/, '')}.s`;

function persisted(userId: string | null) {
  return JSON.stringify({
    state: userId ? { isAuthenticated: true, user: { id: userId, username: userId }, permissions: [] } : { isAuthenticated: false, user: null },
    version: 0,
  });
}

/** One tab: its own store over the shared localStorage, with the summary guard and session. */
function tab(options: { refresh?: () => Promise<{ access_token: string }>; account?: (token: string) => Promise<User> } = {}) {
  const summary = createSessionSummaryStorage<unknown>({ key: KEY });
  const events = new EventTarget();
  const store = createAuthStore<User>({
    persistKey: KEY,
    persistOptions: {
      storage: summary.storage as never,
      partialize: (state) => ({ isAuthenticated: state.isAuthenticated, user: state.user, permissions: state.permissions }),
    },
  });
  const session = createCookieSession<User, User>({
    store,
    refresh: options.refresh ?? (async () => ({ access_token: token('u1', 's1') })),
    fetchAccount: options.account ?? (async (value) => ({ id: JSON.parse(atob(value.split('.')[1])).sub, username: 'x' })),
    toState: (account) => ({ user: account, permissions: ['*'] }),
    sessionKey: jwtSessionKey(['sub', 'sid']),
    locks: null,
    summary,
    persistKey: KEY,
    events,
  });
  /** Deliver another tab's write as a `storage` event. */
  const storageEvent = (newValue: string | null) => {
    const event = new Event('storage') as StorageEvent;
    Object.defineProperty(event, 'key', { value: KEY });
    Object.defineProperty(event, 'newValue', { value: newValue });
    events.dispatchEvent(event);
  };
  return { store, session, summary, storageEvent };
}

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe('cookie session restore', () => {
  it('restores the persisted summary once and adopts the refreshed token', async () => {
    localStorage.setItem(KEY, persisted('u1'));
    const refresh = vi.fn(async () => ({ access_token: token('u1', 's1') }));
    const { store, session } = tab({ refresh });
    expect(session.needsRestore()).toBe(true);
    const [a, b] = await Promise.all([session.restore(), session.restore()]);
    expect([a, b]).toEqual(['authenticated', 'authenticated']);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(store.getState().token).toBe(token('u1', 's1'));
  });

  it('never moves the page into another account and signs out instead', async () => {
    localStorage.setItem(KEY, persisted('u1'));
    const { store, session } = tab({ refresh: async () => ({ access_token: token('u2', 's2') }) });
    expect(await session.restore()).toBe('anonymous');
    expect(store.getState().isAuthenticated).toBe(false);
  });

  it('reports an unknown outcome (timeout/network) as failed and keeps the summary', async () => {
    localStorage.setItem(KEY, persisted('u1'));
    const { store, session } = tab({ refresh: async () => Promise.reject(new Error('timed out')) });
    expect(await session.restore()).toBe('failed');
    expect(store.getState().isAuthenticated).toBe(true);
  });

  it('releases the cross-tab lock when the exchange fails', async () => {
    localStorage.setItem(KEY, persisted('u1'));
    const held: string[] = [];
    const locks = {
      request: vi.fn(async (name: string, task: () => Promise<unknown>) => {
        held.push(name);
        try {
          return await task();
        } finally {
          held.pop();
        }
      }),
    };
    const store = createAuthStore<User>({ persistKey: KEY });
    const session = createCookieSession<User, User>({
      store,
      refresh: async () => Promise.reject(new Error('timed out')),
      fetchAccount: async () => ({ id: 'u1', username: 'x' }),
      toState: (account) => ({ user: account, permissions: [] }),
      sessionKey: jwtSessionKey(['sub', 'sid']),
      locks: locks as never,
      events: null,
    });
    expect(await session.restore()).toBe('failed');
    expect(locks.request).toHaveBeenCalledWith('zucker-account-refresh', expect.any(Function));
    expect(held).toEqual([]);
  });

  it('guardedRefresh rejects a token issued for another account with 401', async () => {
    let next = token('u1', 's1');
    const { store, session } = tab({ refresh: async () => ({ access_token: next }) });
    await session.adoptToken(token('u1', 's1'));
    expect(store.getState().user?.id).toBe('u1');
    next = token('u1', 's1'); // same session, rotated credential: accepted
    await expect(session.guardedRefresh()).resolves.toEqual({ access_token: next });
    next = token('u2', 's2');
    await expect(session.guardedRefresh()).rejects.toMatchObject({ status: 401 });
  });

  it('guardedRefresh rejects while signed out without exchanging the cookie', async () => {
    const refresh = vi.fn(async () => ({ access_token: token('u1', 's1') }));
    const { store, session } = tab({ refresh });
    expect(store.getState().isAuthenticated).toBe(false);
    await expect(session.guardedRefresh()).rejects.toMatchObject({ status: 401 });
    expect(refresh).not.toHaveBeenCalled();
    // Signed out while the exchange ran: the result is not handed to the HTTP client.
    await session.adoptToken(token('u1', 's1'));
    refresh.mockImplementationOnce(async () => {
      store.getState().logout();
      return { access_token: token('u1', 's1') };
    });
    await expect(session.guardedRefresh()).rejects.toMatchObject({ status: 401 });
  });

  it('guardedRefresh accepts only the summary account while no access token is held', async () => {
    localStorage.setItem(KEY, persisted('u1'));
    let next = token('u2', 's2');
    const { store, session } = tab({ refresh: async () => ({ access_token: next }) });
    expect(store.getState()).toMatchObject({ isAuthenticated: true, token: null, user: { id: 'u1' } });
    await expect(session.guardedRefresh()).rejects.toMatchObject({ status: 401 });
    next = 'opaque-token';
    await expect(session.guardedRefresh()).rejects.toMatchObject({ status: 401 });
    next = token('u1', 's9');
    await expect(session.guardedRefresh()).resolves.toEqual({ access_token: next });
  });
});

describe('cross-tab session sync', () => {
  it('signs this tab out when another tab signs out', async () => {
    const first = tab();
    await first.session.adoptToken(token('u1', 's1'));
    localStorage.setItem(KEY, persisted(null));
    first.storageEvent(persisted(null));
    expect(first.store.getState().isAuthenticated).toBe(false);
  });

  it('drops this tab when another tab switches account, without overwriting that summary', async () => {
    const first = tab();
    await first.session.adoptToken(token('u1', 's1'));
    // Tab 2 signs in as u2 and persists its summary.
    const other = persisted('u2');
    localStorage.setItem(KEY, other);
    first.storageEvent(other);
    expect(first.store.getState().isAuthenticated).toBe(false);
    expect(localStorage.getItem(KEY)).toBe(other);
  });

  it('never persists this tab’s stale identity over another tab’s summary', async () => {
    const first = tab();
    await first.session.adoptToken(token('u1', 's1'));
    const other = persisted('u2');
    localStorage.setItem(KEY, other); // event not delivered yet
    first.store.getState().updateToken(token('u1', 's1b'));
    first.store.getState().updateUser({ id: 'u1', username: 'renamed' });
    expect(localStorage.getItem(KEY)).toBe(other);
    // An explicit sign-in in this tab still wins.
    await first.session.adoptToken(token('u3', 's3'));
    expect(first.summary.persistedIdentity()).toBe('u3');
  });

  it('ignores same-identity writes from other tabs', async () => {
    const first = tab();
    await first.session.adoptToken(token('u1', 's1'));
    first.storageEvent(persisted('u1'));
    expect(first.store.getState().token).toBe(token('u1', 's1'));
  });
});
