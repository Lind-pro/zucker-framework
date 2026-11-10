import { createCookieRefresh, createHttpClient } from "@zucker-framework/fe-http-client";
import { useAuthStore } from "./stores/auth-store";
import { DEFAULT_LOCALE, isLocale } from "./site/locales";
import { localizedPath } from "./site/url";

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
    // The default locale is unprefixed (/login); the other one keeps its prefix (/zh/login).
    const segment = window.location.pathname.split("/")[1];
    const locale = isLocale(segment) ? segment : DEFAULT_LOCALE;
    const login = new URL(localizedPath(locale, "/login"), window.location.origin);
    login.searchParams.set("redirect", window.location.pathname + window.location.search);
    window.location.replace(login.href);
  },
});

/** Public account failures (including bad passwords) must not refresh/revoke an unrelated session. */
export const accountPublicClient = createHttpClient({
  baseURL: "/api", withCredentials: true,
  getToken: () => null, clearAuth: () => {}, onUnauthorized: () => {},
});
