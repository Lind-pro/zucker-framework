'use client';
import { createUseAuthHydration } from '@zucker-framework/fe-auth';
import { createCookieRefresh, createHttpClient } from '@zucker-framework/fe-http-client';
import { useAuthStore } from '@/lib/stores/auth-store';

/** False on the server and during the first client render, so cached public HTML never depends on a session. */
export const useAuthHydrated = createUseAuthHydration(useAuthStore);

const clearLocalSession = () => {
  useAuthStore.getState().logout();
};

/**
 * Header/shell reads on public pages. Same token and refresh lock as `httpClient`, but an expired
 * session only clears local state: a public page must never redirect a visitor to login.
 */
export const shellClient = createHttpClient({
  baseURL: '/api',
  withCredentials: true,
  getToken: () => useAuthStore.getState().token,
  setToken: (token) => useAuthStore.getState().updateToken(token),
  refreshWithCookie: createCookieRefresh('/api/authorize/refresh'),
  refreshLockName: 'zucker-account-refresh',
  clearAuth: clearLocalSession,
  onUnauthorized: clearLocalSession,
});

export async function readCreditBalance(): Promise<number | null> {
  const balance = await shellClient.get<{ available?: unknown }>('/credits/balance');
  return typeof balance.available === 'number' && Number.isFinite(balance.available) ? balance.available : null;
}

/** Ends the server session first; local state is cleared only once the server confirmed it. */
export async function signOut(): Promise<void> {
  const result = await shellClient.post<{ success?: boolean }>('/authorize/logout', {});
  if (result?.success !== true) throw new Error('Unexpected logout response');
  clearLocalSession();
}
