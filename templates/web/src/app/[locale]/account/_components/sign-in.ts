import { accountSession } from "@/lib/account-session";

/**
 * Completes a sign-in from a freshly issued access token (login, or sign-up without verification):
 * reads the identity using that exact token, then adopts token/user/permissions atomically. A failed
 * sign-in never installs a partial session or borrows a shared cookie belonging to another account.
 */
export async function establishSession(token: string): Promise<void> {
  if (!token) throw new Error("Missing access token");
  await accountSession.settled();
  await accountSession.adoptToken(token);
}
