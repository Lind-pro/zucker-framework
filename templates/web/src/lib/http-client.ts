import { createCookieRefresh, createHttpClient } from "@zucker-framework/fe-http-client";
import { useAuthStore } from "./stores/auth-store";

const clearLocalAuth = () => {
  useAuthStore.getState().logout();
  // Remove the former access-cookie hint; refresh credentials are server-owned HttpOnly cookies.
  if (typeof document !== "undefined") document.cookie = "auth-token=; Max-Age=0; path=/";
};

export const httpClient = createHttpClient({
  baseURL: "/api",
  withCredentials: true,
  getToken: () => useAuthStore.getState().token,
  setToken: (token) => useAuthStore.getState().updateToken(token),
  refreshWithCookie: createCookieRefresh("/api/authorize/refresh"),
  refreshLockName: "zucker-account-refresh",
  clearAuth: clearLocalAuth,
  onUnauthorized: () => {
    clearLocalAuth();
    if (typeof window === "undefined") return;
    const segment = window.location.pathname.split("/")[1];
    const locale = segment === "en" ? "en" : "zh";
    const login = new URL(`/${locale}/login`, window.location.origin);
    login.searchParams.set("redirect", window.location.pathname + window.location.search);
    window.location.replace(login.href);
  },
});

/** Public account failures (including bad passwords) must not refresh/revoke an unrelated session. */
export const accountPublicClient = createHttpClient({
  baseURL: "/api", withCredentials: true,
  getToken: () => null, clearAuth: () => {}, onUnauthorized: () => {},
});
