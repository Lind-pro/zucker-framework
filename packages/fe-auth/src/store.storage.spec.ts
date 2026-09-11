import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalStore, TOKEN_KEY, USER_KEY, REFRESH_TOKEN_KEY } from '@zucker-framework/fe-storage';
import { createAuthStore } from './store';

interface User {
  id: string;
  email: string;
}
const user: User = { id: 'synthetic-user', email: 'synthetic@example.test' };

afterEach(() => localStorage.clear());

describe('auth store and typed storage integration', () => {
  it('makes login, token refresh and profile updates available through storage auth accessors', () => {
    const store = createAuthStore<User>({ storage: LocalStore });
    store.getState().setAuthState({ token: 'access', user });
    expect(LocalStore.getToken()).toBe('access');
    expect(LocalStore.getUserInfo()).toEqual(user);
    expect(LocalStore.has(TOKEN_KEY)).toBe(true);
    expect(LocalStore.has(USER_KEY)).toBe(true);
    expect(LocalStore.has(REFRESH_TOKEN_KEY)).toBe(false);
    expect(LocalStore.has('token')).toBe(false);
    expect(LocalStore.has('userInfo')).toBe(false);

    store.getState().updateToken('rotated');
    store.getState().updateUser({ ...user, email: 'updated@example.test' });
    expect(LocalStore.getToken()).toBe('rotated');
    expect(LocalStore.getUserInfo<User>()?.email).toBe('updated@example.test');

    store.getState().logout();
    expect(LocalStore.getToken()).toBeNull();
    expect(LocalStore.getUserInfo()).toBeNull();
    expect(store.getState().isAuthenticated).toBe(false);
  });

  it('restores a persisted session into the HTTP client token storage before the consumer hydration callback', () => {
    localStorage.setItem(
      'restored-session',
      JSON.stringify({
        version: 1,
        state: { isAuthenticated: true, token: 'restored', user, permissions: [] },
      }),
    );
    const hydrated = vi.fn(() => {
      expect(LocalStore.getToken()).toBe('restored');
      expect(LocalStore.getUserInfo()).toEqual(user);
    });
    const store = createAuthStore<User>({
      storage: LocalStore,
      persistKey: 'restored-session',
      persistOptions: { version: 1, onRehydrateStorage: () => hydrated },
    });
    expect(store.getState().token).toBe('restored');
    expect(hydrated).toHaveBeenCalledOnce();
    expect(LocalStore.getRefreshToken()).toBeNull();
  });

  it('preserves explicit refresh-token consumers without inventing storage keys', () => {
    const store = createAuthStore<User>({ storage: LocalStore });
    store.getState().setAuthState({ token: 'access', refreshToken: 'refresh', user });
    expect(LocalStore.getRefreshToken()).toBe('refresh');
    expect(LocalStore.has('refreshToken')).toBe(false);
    store.getState().logout();
    expect(LocalStore.getRefreshToken()).toBeNull();
  });
});
