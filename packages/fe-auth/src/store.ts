import { create } from 'zustand';
import { persist, type PersistOptions } from 'zustand/middleware';

/** Adapter interface for pluggable auth token/user storage backends. */
export interface StorageAdapter {
  set: (key: string, data: unknown) => void;
  get: <T = unknown>(key: string) => T | null;
  remove: (key: string) => void;
  clearAuth: () => void;
}

/** Configuration for creating an auth store instance. */
export interface AuthStoreConfig {
  storage?: StorageAdapter;
  persistKey?: string;
  /** Consumer migration, hydration and persistence policy, configured before initial hydration. */
  persistOptions?: Omit<PersistOptions<AuthStore, Partial<AuthState>>, 'name'>;
}

/** The authentication state shape managed by the auth store. */
export interface AuthState {
  isAuthenticated: boolean;
  token: string | null;
  refreshToken: string | null;
  user: Record<string, unknown> | null;
  permissions: string[];
}

/** Full auth store interface combining state with actions for authentication management. */
export interface AuthStore extends AuthState {
  setAuthState: (data: {
    token: string;
    refreshToken?: string;
    user: Record<string, unknown>;
    permissions?: string[];
  }) => void;
  updateUser: (user: Record<string, unknown>) => void;
  updatePermissions: (permissions: string[]) => void;
  updateToken: (token: string) => void;
  logout: () => void;
  hasPermission: (permissionCode: string) => boolean;
  hasAnyPermission: (permissionCodes: string[]) => boolean;
  hasAllPermissions: (permissionCodes: string[]) => boolean;
}

/** Create a Zustand-based auth store with optional persistent storage and permission checking. */
export function createAuthStore(config: AuthStoreConfig = {}) {
  const { storage, persistKey = 'auth-storage', persistOptions } = config;

  return create<AuthStore>()(
    persist(
      (set, get) => ({
        isAuthenticated: false,
        token: null,
        refreshToken: null,
        user: null,
        permissions: [],

        setAuthState: (data) => {
          if (storage) {
            storage.set('token', data.token);
            if (data.refreshToken) {
              storage.set('refreshToken', data.refreshToken);
            }
            storage.set('userInfo', data.user);
          }
          set({
            isAuthenticated: true,
            token: data.token,
            refreshToken: data.refreshToken || null,
            user: data.user,
            permissions: data.permissions || [],
          });
        },

        updateUser: (user) => {
          if (storage) {
            storage.set('userInfo', user);
          }
          set({ user });
        },

        updatePermissions: (permissions) => set({ permissions }),

        updateToken: (token) => {
          if (storage) {
            storage.set('token', token);
          }
          set({ token });
        },

        logout: () => {
          if (storage) {
            storage.clearAuth();
          }
          set({
            isAuthenticated: false,
            token: null,
            refreshToken: null,
            user: null,
            permissions: [],
          });
        },

        hasPermission: (permissionCode) => {
          const { permissions } = get();
          if (!permissions || permissions.length === 0) return false;
          if (permissions.includes('*') || permissions.includes('superadmin')) return true;
          if (permissions.includes(permissionCode)) return true;

          if (permissionCode.includes(':')) {
            const [resource, action] = permissionCode.split(':');
            if (permissions.includes(`${resource}:*`)) return true;
            if (permissions.includes(`${resource}.${action}`)) return true;
          }

          return false;
        },

        hasAnyPermission: (permissionCodes) => {
          return permissionCodes.some((code) => get().hasPermission(code));
        },

        hasAllPermissions: (permissionCodes) => {
          return permissionCodes.every((code) => get().hasPermission(code));
        },
      }),
      {
        name: persistKey,
        partialize: (state) => ({
          token: state.token,
          refreshToken: state.refreshToken,
          user: state.user,
          isAuthenticated: state.isAuthenticated,
          permissions: state.permissions,
        }),
        ...persistOptions,
      },
    ),
  );
}
