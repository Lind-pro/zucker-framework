import { acceptsSessionToken, createCookieSession, createSessionRequestScope, jwtSessionKey } from "@zucker-framework/fe-auth";
import { combineAbortSignals, createCookieRefresh, createHttpClient } from "@zucker-framework/fe-http-client";
import { accountPermissions, type AccountIdentity } from "@/app/[locale]/account/_components/account-flow";
import { AUTH_STORAGE_KEY, authSummary, useAuthStore, type AccountUser } from "./stores/auth-store";

const sessionKey = jwtSessionKey(["sub", "sid"]);
const refreshLockName = "zucker-account-refresh";

export const clearLocalAuth = () => {
  useAuthStore.getState().logout();
  if (typeof document !== "undefined") document.cookie = "auth-token=; Max-Age=0; path=/";
};

/** Public sign-in failures must not refresh or revoke another session. */
export const accountPublicClient = createHttpClient({
  baseURL: "/api", withCredentials: true,
  getToken: () => null, clearAuth: () => {}, onUnauthorized: () => {},
});

const cookieRefresh = createCookieRefresh("/api/authorize/refresh");

/** One identity guard for both the public-page shell and authenticated application requests. */
export const accountSession = createCookieSession<AccountUser, AccountIdentity>({
  store: useAuthStore,
  refresh: cookieRefresh,
  fetchAccount: async (token) => {
    const me = await accountPublicClient.get<AccountIdentity>("/authorize/me", undefined, { headers: { Authorization: `Bearer ${token}` } });
    if (!me || typeof me.id !== "string" || !me.id || typeof me.username !== "string" || !Array.isArray(me.permissions))
      throw new Error("Invalid account response");
    return me;
  },
  toState: (me) => ({
    user: { id: me.id, username: me.username, name: me.name, email: me.email },
    permissions: accountPermissions(me),
  }),
  sessionKey,
  lockName: refreshLockName,
  summary: authSummary,
  persistKey: AUTH_STORAGE_KEY,
});

const scope = createSessionRequestScope(() => useAuthStore.getState(), useAuthStore.subscribe, sessionKey);

/** Also bind fetch/SSE requests, which bypass the Axios interceptors. */
export const accountRequestSignal = (signal?: AbortSignal) => combineAbortSignals([scope.signal(), signal]);

/** The cookie may now belong to another tab's account; only an explicit sign-in may adopt it. */
export const refreshAfterPopupSignIn = () => accountSession.withLock(cookieRefresh);

export function createAccountClient(onUnauthorized: () => void) {
  const client = createHttpClient({
    baseURL: "/api", withCredentials: true, refreshLockName,
    getToken: () => useAuthStore.getState().token,
    sessionKey,
    setToken: (token) => {
      const state = useAuthStore.getState();
      if (acceptsSessionToken(state, token, sessionKey)) state.updateToken(token);
    },
    refreshWithCookie: accountSession.guardedRefresh,
    clearAuth: clearLocalAuth,
    onUnauthorized,
  });
  client.getAxiosInstance().interceptors.request.use((config) => {
    // Aborting old work also stops a late 401 from retrying a mutation under a new account.
    config.signal = accountRequestSignal(config.signal as AbortSignal | undefined);
    return config;
  });
  return client;
}
