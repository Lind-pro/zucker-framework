import {
  acceptsSessionToken,
  createAuthStore,
  createCookieSession,
  createSessionRequestScope,
  createSessionSummaryStorage,
  jwtSessionKey,
  type AuthStore,
  type CookieSessionRestoreResult,
} from '@zucker-framework/fe-auth';
import { createUsePermission } from '@zucker-framework/fe-permission';
import {
  combineAbortSignals,
  createHttpClient,
  createKeepaliveCookieRefresh,
  createRefreshExchange,
  type HttpClient,
  type RequestConfig,
} from '@zucker-framework/fe-http-client';
import type { StoreApi, UseBoundStore } from 'zustand';
import { errorStatus } from '../lib/format';
import type { AdminAppConfig, ResolvedAdminConfig } from './config';

export interface AdminUser {
  id: string;
  username: string;
  name?: string | null;
  email?: string | null;
  emailVerified?: boolean;
}

export type AdminAuthStore = UseBoundStore<StoreApi<AuthStore<AdminUser>>>;

export interface RequestOptions {
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

/** HTTP access bound to the signed-in session: requests are aborted when the session changes. */
export interface AdminApi {
  get<T>(path: string, params?: Record<string, unknown>, options?: RequestOptions): Promise<T>;
  post<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T>;
  put<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T>;
  patch<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T>;
  delete<T>(path: string, params?: Record<string, unknown>, options?: RequestOptions): Promise<T>;
}

interface MePermission {
  id: string;
  actions: string[];
}
interface MeResult extends AdminUser {
  permissions?: MePermission[];
}

/** `/authorize/me` returns `{ id: resource, actions }`; the store uses `<resource>:<action>` codes. */
export function permissionsFromMe(permissions: readonly MePermission[] | undefined): string[] {
  if (!Array.isArray(permissions)) return [];
  return [
    ...new Set(
      permissions.flatMap((permission) => {
        if (!permission || typeof permission.id !== 'string') return [];
        if (permission.id === '*' || permission.id === 'superadmin') return [permission.id];
        const actions: unknown[] = Array.isArray(permission.actions) ? permission.actions : [];
        return actions
          .filter((action): action is string => typeof action === 'string' && action !== '')
          .map((action) => `${permission.id}:${action}`);
      }),
    ),
  ];
}

function validMe(value: unknown): value is MeResult {
  const me = value as MeResult | null;
  return !!me && typeof me.id === 'string' && !!me.id && typeof me.username === 'string';
}

function bindApi(client: HttpClient, scopeSignal: () => AbortSignal | undefined): AdminApi {
  const options = (extra?: RequestOptions): Omit<RequestConfig, 'method' | 'data'> => ({
    ...(extra?.headers ? { headers: extra.headers } : {}),
    signal: combineAbortSignals([scopeSignal(), extra?.signal]),
  });
  return {
    get: (path, params, extra) => client.get(path, params, options(extra)),
    post: (path, body, extra) => client.post(path, body, undefined, options(extra)),
    put: (path, body, extra) => client.put(path, body, options(extra)),
    patch: (path, body, extra) => client.patch(path, body, options(extra)),
    delete: (path, params, extra) => client.delete(path, params, options(extra)),
  };
}

export type RestoreResult = CookieSessionRestoreResult;

/**
 * `POST /authorize/login` accepted the password but the account has two-factor sign-in:
 * no session was opened. Finish with `session.loginTwoFactor(error.challenge, …)`.
 * The challenge is a short-lived one-time ticket; keep it in memory only.
 */
export class AdminTwoFactorRequiredError extends Error {
  readonly twoFactorRequired = true;
  constructor(readonly challenge: string) {
    super('Two-factor verification required');
    this.name = 'AdminTwoFactorRequiredError';
  }
}

/** Second factor for {@link AdminSession.loginTwoFactor}: an authenticator code or a recovery code. */
export type AdminTwoFactorFactor = { code: string } | { recoveryCode: string };

function twoFactorChallenge(result: unknown): string | null {
  const value = result as { twoFactorRequired?: unknown; challenge?: unknown } | null;
  return value?.twoFactorRequired === true && typeof value.challenge === 'string' && value.challenge
    ? value.challenge
    : null;
}

export interface AdminSession {
  store: AdminAuthStore;
  client: HttpClient;
  publicClient: HttpClient;
  api: AdminApi;
  publicApi: AdminApi;
  /** fe-permission hook bound to this session's store (wildcard, `superadmin`, `resource:*`). */
  usePermission: ReturnType<typeof createUsePermission>;
  /** Whether a persisted session summary exists but its access token must be restored by cookie refresh. */
  needsRestore: () => boolean;
  restore: () => Promise<RestoreResult>;
  /** Throws {@link AdminTwoFactorRequiredError} when the account needs a second factor. */
  login: (username: string, password: string) => Promise<AdminUser>;
  /** Complete a two-factor sign-in (`POST <login>/two-factor`). */
  loginTwoFactor: (challenge: string, factor: AdminTwoFactorFactor) => Promise<AdminUser>;
  logout: () => Promise<void>;
  /** Re-read the signed-in user and permissions. */
  reloadMe: () => Promise<void>;
  dispose: () => void;
}

/**
 * Session handling for the server template account module (`/authorize/*`):
 * - the access token lives in memory only; the refresh token is an HttpOnly cookie;
 * - the persisted summary (user + permissions) lets a reload restore the session via cookie refresh;
 * - refreshed or header-supplied tokens are accepted only for the same session (sub + sid claims);
 * - in-flight requests are aborted when the user or session changes;
 * - the refresh exchange itself is never aborted: the server rotates the refresh token as soon as it
 *   accepts the request, so cancelling it would lose the rotated cookie and sign the user out. It
 *   survives page unloads (keepalive) and in-app navigation, and a restore runs once per page.
 */
export function createAdminSession(config: AdminAppConfig, resolved: ResolvedAdminConfig): AdminSession {
  const { endpoints } = resolved;
  const sessionKey = jwtSessionKey(config.session?.claims ?? ['sub', 'sid']);
  const lockName = config.session?.refreshLockName ?? 'zucker-account-refresh';
  const persistKey = config.session?.storageKey ?? 'zucker-admin-session';
  // Guards the persisted summary against this tab overwriting another tab's account (fe-auth).
  const summary = createSessionSummaryStorage<unknown>({ key: persistKey });
  const store: AdminAuthStore = createAuthStore<AdminUser>({
    persistKey,
    persistOptions: {
      storage: summary.storage as never,
      // Neither token is persisted: the refresh token is HttpOnly and the access token is re-issued.
      partialize: (state) => ({ isAuthenticated: state.isAuthenticated, user: state.user, permissions: state.permissions }),
    },
  });
  // Keepalive transport + interrupted-exchange marker + timeout (fe-http-client).
  const cookieRefresh = createRefreshExchange({
    transport: config.refresh ?? createKeepaliveCookieRefresh(`${resolved.apiBase}${endpoints.refresh}`),
    markerKey: `${lockName}:in-flight`,
    ...(config.session?.refreshTimeoutMs ? { timeoutMs: config.session.refreshTimeoutMs } : {}),
  });
  const shared = {
    baseURL: resolved.apiBase,
    timeout: config.timeout ?? 60000,
    withCredentials: true,
    refreshLockName: lockName,
  };
  const publicClient = createHttpClient({
    ...shared,
    getToken: () => null,
    clearAuth: () => undefined,
    onUnauthorized: () => undefined,
  });

  async function fetchMe(token: string): Promise<MeResult> {
    const me = await publicClient.get<unknown>(endpoints.me, undefined, { headers: { Authorization: `Bearer ${token}` } });
    if (!validMe(me)) throw new Error('Invalid account response');
    return me;
  }
  // Restore-once, identity guard, cross-tab lock and cross-tab sign-out/switch handling (fe-auth).
  const cookieSession = createCookieSession<AdminUser, MeResult>({
    store,
    refresh: cookieRefresh,
    fetchAccount: fetchMe,
    toState: (me) => ({
      user: { id: me.id, username: me.username, name: me.name ?? null, email: me.email ?? null, emailVerified: me.emailVerified },
      permissions: permissionsFromMe(me.permissions),
    }),
    sessionKey,
    lockName,
    summary,
    persistKey,
    statusOf: (error) => errorStatus(error) ?? (error as { response?: { status?: number } }).response?.status,
  });
  const client = createHttpClient({
    ...shared,
    refreshWithCookie: () => cookieSession.guardedRefresh(),
    getToken: () => store.getState().token,
    setToken: (token) => {
      const state = store.getState();
      if (acceptsSessionToken(state, token, sessionKey)) state.updateToken(token);
    },
    clearAuth: () => store.getState().logout(),
    // The shell reacts to the cleared store and routes to /login with the current location.
    onUnauthorized: () => store.getState().logout(),
    onForbidden: () => undefined,
  });
  if (config.httpAdapter) {
    client.getAxiosInstance().defaults.adapter = config.httpAdapter;
    publicClient.getAxiosInstance().defaults.adapter = config.httpAdapter;
  }
  const scope = createSessionRequestScope(() => store.getState(), store.subscribe, sessionKey);
  const api = bindApi(client, () => scope.signal());
  const publicApi = bindApi(publicClient, () => undefined);

  return {
    store,
    client,
    publicClient,
    api,
    publicApi,
    usePermission: createUsePermission({ useAuthStore: store }),
    needsRestore: () => cookieSession.needsRestore(),
    restore: () => cookieSession.restore(),
    async login(username, password) {
      // Let a pending restore settle first so its result cannot replace this sign-in.
      await cookieSession.settled();
      const result = await publicClient.post<{ token?: unknown }>(endpoints.login, { username, password });
      // Servers without two-factor sign-in never return the flag: behaviour unchanged for them.
      const challenge = twoFactorChallenge(result);
      if (challenge) throw new AdminTwoFactorRequiredError(challenge);
      if (typeof result?.token !== 'string' || !result.token) throw new Error('Missing access token');
      await cookieSession.adoptToken(result.token);
      return store.getState().user as AdminUser;
    },
    async loginTwoFactor(challenge, factor) {
      await cookieSession.settled();
      const body = 'recoveryCode' in factor
        ? { challenge, recoveryCode: factor.recoveryCode }
        : { challenge, code: factor.code };
      const result = await publicClient.post<{ token?: unknown }>(`${endpoints.login}/two-factor`, body);
      if (typeof result?.token !== 'string' || !result.token) throw new Error('Missing access token');
      await cookieSession.adoptToken(result.token);
      return store.getState().user as AdminUser;
    },
    async logout() {
      try {
        const result = await api.post<{ success?: boolean }>(endpoints.logout);
        if (result?.success !== true) throw new Error('Unexpected logout response');
      } catch (error) {
        // An already expired session is signed out; anything else must be retried.
        if (errorStatus(error) !== 401) throw error;
      }
      store.getState().logout();
    },
    async reloadMe() {
      const token = store.getState().token;
      if (!token) return;
      const me = await api.get<unknown>(endpoints.me);
      if (!validMe(me)) throw new Error('Invalid account response');
      const state = store.getState();
      if (state.user?.id !== me.id) return;
      state.updateUser({ ...state.user, name: me.name ?? null, email: me.email ?? null, emailVerified: me.emailVerified });
      state.updatePermissions(permissionsFromMe(me.permissions));
    },
    dispose: () => {
      scope.dispose();
      cookieSession.dispose();
    },
  };
}
