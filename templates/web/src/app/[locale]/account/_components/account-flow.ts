export interface AccountIdentity {
  id: string;
  username: string;
  name?: string;
  email?: string;
  emailVerified?: boolean;
  permissions: Array<{ id: string; actions: string[] }>;
}

export function accountPermissions(identity: AccountIdentity): string[] {
  return identity.permissions.flatMap((permission) =>
    permission.id === "*" || permission.id === "superadmin" ? [permission.id]
      : permission.actions.map((action) => `${permission.id}:${action}`));
}

/** The locale-aware router adds the active locale; never navigate to an external/unimplemented target. */
export function accountReturnPath(raw: string | null): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || /[\\\u0000-\u001f]/.test(raw)) return "/account";
  try {
    const decoded = decodeURIComponent(raw);
    if (decoded.startsWith("//") || /[\\\u0000-\u001f]/.test(decoded)) return "/account";
    const parsed = new URL(raw, "https://account.invalid");
    const path = parsed.pathname.replace(/^\/(?:zh|en)(?=\/|$)/, "") || "/";
    if (path === "/pricing") return path + parsed.search;
    // Management IDs are path segments, never encoded separators or a second round of URL decoding.
    if (["/content/manage", "/billing/subscriptions"].some(prefix => path === prefix || path.startsWith(`${prefix}/`))) {
      return /%(?:2f|5c|2e|25)/i.test(path) ? "/account" : path + parsed.search;
    }
    if (!["/account", "/dashboard", "/billing"].some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) return "/account";
    return path + parsed.search;
  } catch { return "/account"; }
}

export function accountErrorKey(error: unknown, fallback: string): string {
  if (!error || typeof error !== "object") return fallback;
  const status = "status" in error ? error.status : undefined;
  const message = "message" in error && typeof error.message === "string" ? error.message : "";
  if (/Invalid (or expired )?ticket/i.test(message)) return "invalidTicket";
  if (status === 400) return "invalidInput";
  if (status === 409) return "accountExists";
  if (status === 429) return "tooManyRequests";
  if (status === 503) return "serviceUnavailable";
  if (status === 403) return "requestRejected";
  return fallback;
}

/**
 * POST /authorize/register answers `{verificationRequired:true}` (a verification mail was sent) or,
 * when the account policy turns verification off, `{verificationRequired:false, userId, token, expires}`
 * plus the refresh cookie: the account exists and is already signed in. Anything else is unexpected.
 */
export type RegisterOutcome = { kind: "verify" } | { kind: "signed-in"; token: string };
export function registerOutcome(result: unknown): RegisterOutcome {
  const value = result && typeof result === "object" ? result as Record<string, unknown> : {};
  if (value.verificationRequired === true) return { kind: "verify" };
  if (value.verificationRequired === false && typeof value.token === "string" && value.token) return { kind: "signed-in", token: value.token };
  throw new Error("Unexpected account response");
}
