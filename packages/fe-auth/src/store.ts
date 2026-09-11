import { create } from 'zustand';
import { persist, type PersistOptions } from 'zustand/middleware';

/** Adapter interface for pluggable auth token/user storage backends. */
export interface StorageAdapter<TUser extends object = Record<string, unknown>> {
  set: (key: string, data: unknown) => void;
  get: <T = unknown>(key: string) => T | null;
  remove: (key: string) => void;
  clearAuth: () => void;
  /** Use the storage backend's auth keys when it exposes typed auth accessors. */
  setToken?: (token: string) => void;
  setRefreshToken?: (token: string) => void;
  setUserInfo?: (user: TUser) => void;
}

/** Configuration for creating an auth store instance. */
export interface AuthStoreConfig<TUser extends object = Record<string, unknown>> {
  storage?: StorageAdapter<TUser>;
  /** Consumer-specific authorization vocabulary; defaults to the existing wildcard matcher. */
  permissionMatcher?: (permissions: string[], permission: string) => boolean;
  onBeforeLogout?: () => void;
  onAfterLogout?: () => void;
  persistKey?: string;
  /** Consumer migration, hydration and persistence policy, configured before initial hydration. */
  persistOptions?: Omit<PersistOptions<AuthStore<TUser>, Partial<AuthState<TUser>>>, 'name'>;
}

/** The authentication state shape managed by the auth store. */
export interface AuthState<TUser extends object = Record<string, unknown>> {
  isAuthenticated: boolean;
  token: string | null;
  refreshToken: string | null;
  user: TUser | null;
  permissions: string[];
}

/** Full auth store interface combining state with actions for authentication management. */
export interface AuthStore<
  TUser extends object = Record<string, unknown>,
> extends AuthState<TUser> {
  setAuthState: (data: {
    token: string;
    refreshToken?: string;
    user: TUser;
    permissions?: string[];
  }) => void;
  updateUser: (user: TUser) => void;
  updatePermissions: (permissions: string[]) => void;
  updateToken: (token: string) => void;
  logout: () => void;
  hasPermission: (permissionCode: string) => boolean;
  hasAnyPermission: (permissionCodes: string[]) => boolean;
  hasAllPermissions: (permissionCodes: string[]) => boolean;
}

/** Create a Zustand-based auth store with optional persistent storage and permission checking. */
export function createAuthStore<TUser extends object = Record<string, unknown>>(
  config: AuthStoreConfig<TUser> = {},
) {
  const { storage, persistKey = 'auth-storage', persistOptions } = config;

  const saveToken = (token: string) => {
    if (storage?.setToken) storage.setToken(token);
    else storage?.set('token', token);
  };
  const saveUser = (user: TUser) => {
    if (storage?.setUserInfo) storage.setUserInfo(user);
    else storage?.set('userInfo', user);
  };

  return create<AuthStore<TUser>>()(
    persist(
      (set, get) => ({
        isAuthenticated: false,
        token: null,
        refreshToken: null,
        user: null,
        permissions: [],

        setAuthState: (data) => {
          if (storage) {
            saveToken(data.token);
            if (data.refreshToken) {
              if (storage.setRefreshToken) storage.setRefreshToken(data.refreshToken);
              else storage.set('refreshToken', data.refreshToken);
            }
            saveUser(data.user);
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
            saveUser(user);
          }
          set({ user });
        },

        updatePermissions: (permissions) => set({ permissions }),

        updateToken: (token) => {
          if (storage) {
            saveToken(token);
          }
          set({ token });
        },

        logout: () => {
          try {
            config.onBeforeLogout?.();
          } finally {
            try {
              storage?.clearAuth();
            } finally {
              set({
                isAuthenticated: false,
                token: null,
                refreshToken: null,
                user: null,
                permissions: [],
              });
              config.onAfterLogout?.();
            }
          }
        },

        hasPermission: (permissionCode) => {
          const { permissions } = get();
          if (config.permissionMatcher)
            return config.permissionMatcher(permissions, permissionCode);
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
        onRehydrateStorage: (state) => {
          const onHydrated = persistOptions?.onRehydrateStorage?.(state);
          return (hydrated, error) => {
            if (!error && hydrated?.isAuthenticated && hydrated.token) {
              saveToken(hydrated.token);
              if (hydrated.user) saveUser(hydrated.user);
            }
            onHydrated?.(hydrated, error);
          };
        },
      },
    ),
  );
}
