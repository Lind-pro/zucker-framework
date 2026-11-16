import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAuthStore, type StorageAdapter } from './store';

describe('fe-auth createAuthStore', () => {
  let mockStorage: StorageAdapter;

  beforeEach(() => {
    const store: Record<string, unknown> = {};
    mockStorage = {
      set: vi.fn((key, data) => { store[key] = data; }),
      get: vi.fn((key) => (store[key] as any) ?? null),
      remove: vi.fn((key) => { delete store[key]; }),
      clearAuth: vi.fn(() => {
        delete store['token'];
        delete store['refreshToken'];
        delete store['userInfo'];
      }),
    };
  });

  it('should initialize with unauthenticated state', () => {
    const useAuth = createAuthStore();
    const state = useAuth.getState();
    expect(state.isAuthenticated).toBe(false);
    expect(state.token).toBeNull();
    expect(state.user).toBeNull();
    expect(state.permissions).toEqual([]);
  });

  it('should set auth state with token, user and permissions', () => {
    const useAuth = createAuthStore({ storage: mockStorage });
    useAuth.getState().setAuthState({
      token: 'access-123',
      refreshToken: 'refresh-456',
      user: { id: 1, name: 'Alice' },
      permissions: ['read', 'write'],
    });

    const state = useAuth.getState();
    expect(state.isAuthenticated).toBe(true);
    expect(state.token).toBe('access-123');
    expect(state.refreshToken).toBe('refresh-456');
    expect(state.user).toEqual({ id: 1, name: 'Alice' });
    expect(state.permissions).toEqual(['read', 'write']);
    expect(mockStorage.set).toHaveBeenCalledWith('token', 'access-123');
    expect(mockStorage.set).toHaveBeenCalledWith('userInfo', { id: 1, name: 'Alice' });
  });

  it('should logout and clear state + storage', () => {
    const useAuth = createAuthStore({ storage: mockStorage });
    useAuth.getState().setAuthState({
      token: 't',
      user: { id: 1 },
    });
    useAuth.getState().logout();

    const state = useAuth.getState();
    expect(state.isAuthenticated).toBe(false);
    expect(state.token).toBeNull();
    expect(state.user).toBeNull();
    expect(mockStorage.clearAuth).toHaveBeenCalled();
  });

  it('should update user and persist to storage', () => {
    const useAuth = createAuthStore({ storage: mockStorage });
    useAuth.getState().updateUser({ id: 2, name: 'Bob' });
    expect(useAuth.getState().user).toEqual({ id: 2, name: 'Bob' });
    expect(mockStorage.set).toHaveBeenCalledWith('userInfo', { id: 2, name: 'Bob' });
  });

  it('should update token and persist to storage', () => {
    const useAuth = createAuthStore({ storage: mockStorage });
    useAuth.getState().updateToken('new-token');
    expect(useAuth.getState().token).toBe('new-token');
    expect(mockStorage.set).toHaveBeenCalledWith('token', 'new-token');
  });

  it('should update permissions', () => {
    const useAuth = createAuthStore();
    useAuth.getState().updatePermissions(['admin', 'edit']);
    expect(useAuth.getState().permissions).toEqual(['admin', 'edit']);
  });

  describe('hasPermission', () => {
    it('should return false with no permissions', () => {
      const useAuth = createAuthStore();
      expect(useAuth.getState().hasPermission('read')).toBe(false);
    });

    it('should match exact permission', () => {
      const useAuth = createAuthStore();
      useAuth.getState().updatePermissions(['user:read', 'user:write']);
      expect(useAuth.getState().hasPermission('user:read')).toBe(true);
      expect(useAuth.getState().hasPermission('user:delete')).toBe(false);
    });

    it('should grant all with superadmin or wildcard', () => {
      const useAuth = createAuthStore();
      useAuth.getState().updatePermissions(['superadmin']);
      expect(useAuth.getState().hasPermission('anything')).toBe(true);

      useAuth.getState().updatePermissions(['*']);
      expect(useAuth.getState().hasPermission('whatever')).toBe(true);
    });

    it('should match resource wildcard (resource:*)', () => {
      const useAuth = createAuthStore();
      useAuth.getState().updatePermissions(['user:*']);
      expect(useAuth.getState().hasPermission('user:delete')).toBe(true);
      expect(useAuth.getState().hasPermission('post:delete')).toBe(false);
    });
  });

  describe('hasAnyPermission / hasAllPermissions', () => {
    it('hasAnyPermission returns true if any match', () => {
      const useAuth = createAuthStore();
      useAuth.getState().updatePermissions(['user:read']);
      expect(useAuth.getState().hasAnyPermission(['user:read', 'user:write'])).toBe(true);
      expect(useAuth.getState().hasAnyPermission(['post:read'])).toBe(false);
    });

    it('hasAllPermissions returns true only if all match', () => {
      const useAuth = createAuthStore();
      useAuth.getState().updatePermissions(['user:read', 'user:write']);
      expect(useAuth.getState().hasAllPermissions(['user:read', 'user:write'])).toBe(true);
      expect(useAuth.getState().hasAllPermissions(['user:read', 'user:delete'])).toBe(false);
    });
  });
});
