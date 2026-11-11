import { accountPublicClient, httpClient } from "@/lib/http-client";
import { accountSecurityPolicy, type AccountSecurityPolicy } from "./sign-in-flow";

/** Errors are explained inline by each screen; never a global toast. */
const quiet = { _hideError: true } as const;

export interface TwoFactorStatus {
  available: boolean;
  status: "off" | "pending" | "active";
  confirmedAt: string | null;
  recoveryCodesRemaining: number;
  enrolmentAllowed: boolean;
}

/**
 * Public steps (login second factor, magic link, deletion cancel) use `accountPublicClient`: a wrong code
 * or password must never refresh or revoke an unrelated session. Signed-in steps use `httpClient`; the
 * server answers recent-authentication failures with 403, never 401, so they do not end the session.
 */
export const accountSecurityApi = {
  publicPolicy: async (): Promise<AccountSecurityPolicy> =>
    accountSecurityPolicy(await accountPublicClient.get<unknown>("/site/public/config", undefined, quiet)),
  loginTwoFactor: (body: { challenge: string; code: string } | { challenge: string; recoveryCode: string }) =>
    accountPublicClient.post<unknown>("/authorize/login/two-factor", body, undefined, quiet),
  requestMagicLink: (email: string) => accountPublicClient.post<{ accepted?: boolean }>("/authorize/magic-link", { email }, undefined, quiet),
  consumeMagicLink: (ticket: string) => accountPublicClient.post<unknown>("/authorize/magic-link/consume", { ticket }, undefined, quiet),
  cancelDeletion: (body: { username: string; password: string } | { ticket: string }) =>
    accountPublicClient.post<{ cancelled?: boolean }>("/authorize/deletion/cancel", body, undefined, quiet),

  status: () => httpClient.get<TwoFactorStatus>("/authorize/two-factor/status", undefined, quiet),
  enrol: (password: string) =>
    httpClient.post<{ secret: string; otpauthUri: string }>("/authorize/two-factor/enrol", password ? { password } : {}, undefined, quiet),
  confirm: (code: string) => httpClient.post<{ recoveryCodes: string[] }>("/authorize/two-factor/confirm", { code }, undefined, quiet),
  disable: (body: Record<string, string>) => httpClient.post<{ success?: boolean }>("/authorize/two-factor/disable", body, undefined, quiet),
  regenerate: (body: Record<string, string>) =>
    httpClient.post<{ recoveryCodes: string[] }>("/authorize/two-factor/recovery-codes", body, undefined, quiet),
  scheduleDeletion: (body: { confirm: string; reason?: string; password?: string }) =>
    httpClient.post<{ scheduled?: boolean; executeAfter?: string }>("/authorize/deletion", body, undefined, quiet),
};
