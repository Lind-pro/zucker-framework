import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAuthStore } from './store';

afterEach(() => localStorage.clear());

describe('consumer auth policies', () => {
  it('preserves typed user data and omits refresh tokens from selected persistence', () => {
    const store = createAuthStore<{ id: string; email: string }>({
      persistKey: 'consumer-test',
      permissionMatcher: (permissions, permission) => permissions.includes(permission),
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
      .setAuthState({
        token: 'access',
        user: { id: 'u1', email: 'synthetic@example.test' },
        permissions: ['records:*'],
      });
    expect(store.getState().user?.email).toBe('synthetic@example.test');
    expect(store.getState().hasPermission('records:delete')).toBe(false);
    const saved = JSON.parse(localStorage.getItem('consumer-test')!);
    expect(saved.state).not.toHaveProperty('refreshToken');
  });
  it('clears authentication even when product cleanup fails, then runs the navigation hook', () => {
    const after = vi.fn();
    const store = createAuthStore({
      onBeforeLogout: () => {
        throw new Error('cleanup failed');
      },
      onAfterLogout: after,
    });
    store.getState().setAuthState({ token: 'access', user: { id: 'u1' } });
    expect(() => store.getState().logout()).toThrow('cleanup failed');
    expect(store.getState()).toMatchObject({
      token: null,
      user: null,
      isAuthenticated: false,
      permissions: [],
    });
    expect(after).toHaveBeenCalledOnce();
  });
});
