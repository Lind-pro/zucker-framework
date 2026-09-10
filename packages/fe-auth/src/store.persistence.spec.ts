import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAuthStore } from './store';

beforeEach(() => localStorage.clear());

describe('consumer auth persistence policy', () => {
  it('restores an existing versioned session on initial hydration', () => {
    localStorage.setItem(
      'session',
      JSON.stringify({
        version: 1,
        state: {
          token: 'access',
          user: { id: 'existing' },
          permissions: ['resource:read'],
          isAuthenticated: true,
        },
      }),
    );
    const hydrated = vi.fn();
    const store = createAuthStore({
      persistKey: 'session',
      persistOptions: { version: 1, onRehydrateStorage: () => hydrated },
    });
    expect(store.getState()).toMatchObject({
      token: 'access',
      user: { id: 'existing' },
      isAuthenticated: true,
    });
    expect(store.getState().hasPermission('resource:read')).toBe(true);
    expect(hydrated).toHaveBeenCalledTimes(1);
  });
  it('lets cookie-based consumers omit refresh tokens from persisted state', () => {
    const store = createAuthStore({
      persistKey: 'cookie-session',
      persistOptions: {
        partialize: ({ token, user, permissions, isAuthenticated }) => ({
          token,
          user,
          permissions,
          isAuthenticated,
        }),
      },
    });
    store
      .getState()
      .setAuthState({ token: 'access', refreshToken: 'must-not-persist', user: { id: 'example' } });
    expect(localStorage.getItem('cookie-session')).not.toContain('must-not-persist');
    expect(JSON.parse(localStorage.getItem('cookie-session')!).state.token).toBe('access');
  });
  it('preserves the existing default persistence contract', () => {
    const store = createAuthStore({ persistKey: 'legacy-session' });
    store
      .getState()
      .setAuthState({ token: 'access', refreshToken: 'legacy-refresh', user: { id: 'example' } });
    expect(JSON.parse(localStorage.getItem('legacy-session')!).state.refreshToken).toBe(
      'legacy-refresh',
    );
  });
});
