import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAuthStore } from './store';
import { createCookieSession } from './cookie-session';
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('Package review regressions', () => {
  it.each([401, 403])('R08: stale restore failure %s preserves a newly adopted account', async status => {
    const refresh = deferred<{ access_token: string }>();
    const store = createAuthStore<{ id: string }>({ persistKey: 'audit-cookie-session' });
    store.setState({ isAuthenticated: true, user: { id: 'A' }, token: null });
    const session = createCookieSession({ store, refresh: () => refresh.promise,
      fetchAccount: async () => ({ id: 'B' }), toState: user => ({ user, permissions: [] }),
      sessionKey: token => token, locks: null, events: null });
    const restoring = session.restore();
    await session.adoptToken('account-B');
    expect(store.getState().user?.id).toBe('B');
    refresh.reject(Object.assign(new Error('old cookie rejected'), { status }));
    expect(await restoring).toBe('authenticated');
    expect(store.getState().user?.id).toBe('B');
    session.dispose();
  });


  it('discards restore success after sign-out and a new summary for the same user', async () => {
    const refresh = deferred<{ access_token: string }>();
    const store = createAuthStore<{ id: string }>({ persistKey: 'restore-generation' });
    store.setState({ isAuthenticated: true, user: { id: 'A' }, token: null });
    const session = createCookieSession({ store, refresh: () => refresh.promise,
      fetchAccount: async () => ({ id: 'A' }), toState: user => ({ user, permissions: [] }),
      sessionKey: token => token, locks: null, events: null });
    const restoring = session.restore();
    store.getState().logout();
    store.setState({ isAuthenticated: true, user: { id: 'A' }, token: null });
    refresh.resolve({ access_token: 'stale' });
    await restoring;
    expect(store.getState().token).toBeNull();
    session.dispose();
  });

});
