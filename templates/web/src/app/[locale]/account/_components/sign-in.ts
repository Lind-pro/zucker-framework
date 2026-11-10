import { useAuthStore } from "@/lib/stores/auth-store";
import { httpClient } from "@/lib/http-client";
import { accountPermissions, type AccountIdentity } from "./account-flow";

/**
 * Completes a sign-in from a freshly issued access token (login, or sign-up without verification):
 * stores the token, loads the identity and permissions, and fills the fe-auth store. On failure the
 * partial session is cleared and the error is rethrown for the page's message.
 */
export async function establishSession(token: string): Promise<void> {
  if (!token) throw new Error("Missing access token");
  const store = useAuthStore.getState();
  store.updateToken(token);
  try {
    const me = await httpClient.get<AccountIdentity>("/authorize/me");
    useAuthStore.getState().setAuthState({ token: useAuthStore.getState().token || token,
      user: { id: me.id, username: me.username, name: me.name, email: me.email },
      permissions: accountPermissions(me) });
  } catch (error) {
    useAuthStore.getState().logout();
    throw error;
  }
}
