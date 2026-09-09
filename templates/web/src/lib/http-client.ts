import { createHttpClient } from "@zucker-framework/fe-http-client";
import { useAuthStore } from "./stores/auth-store";

export const httpClient = createHttpClient({
  baseURL: "/api",

  getToken: () => useAuthStore.getState().token,
  setToken: (token) => useAuthStore.getState().updateToken(token),

  clearAuth: () => {
    useAuthStore.getState().logout();
    if (typeof document !== "undefined") {
      document.cookie = "auth-token=; Max-Age=0; path=/";
    }
  },

  onUnauthorized: () => {
    useAuthStore.getState().logout();
    if (typeof document !== "undefined") {
      document.cookie = "auth-token=; Max-Age=0; path=/";
    }
    if (typeof window !== "undefined") {
      const locale = window.location.pathname.split("/")[1] || "zh";
      window.location.href = `/${locale}/login`;
    }
  },
});
