import { createAuthStore, createSessionSummaryStorage, type AuthState } from "@zucker-framework/fe-auth";

export interface AccountUser {
  id: string;
  username: string;
  name?: string;
  email?: string;
}

export const AUTH_STORAGE_KEY = "auth-storage";
export const authSummary = createSessionSummaryStorage<Partial<AuthState<AccountUser>>>({ key: AUTH_STORAGE_KEY });

// Keep the existing persisted shape/key. The guard prevents a stale tab from overwriting the
// other account's storage when its cookie refresh is rejected or a storage event signs it out.
export const useAuthStore = createAuthStore<AccountUser>({
  persistKey: AUTH_STORAGE_KEY,
  persistOptions: { storage: authSummary.storage },
});
