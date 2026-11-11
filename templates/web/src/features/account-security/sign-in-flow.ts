/**
 * Pure helpers for the web sign-in and account-security screens. Node tests load this file directly,
 * so it has no imports. The server re-validates everything; these checks only shape requests and
 * explain failures. Only known server codes are trusted (never the message text).
 */

/** Outcome of `POST /authorize/login`, `/magic-link/consume` and `/oauth/:provider/complete`. */
export type SignInResult =
  | { kind: "session"; token: string; returnPath?: string }
  | { kind: "two-factor"; challenge: string; returnPath?: string };

const TICKET = /^[A-Za-z0-9_-]{43}$/;

function optionalPath(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/**
 * `{token}` opens a session; `{twoFactorRequired: true, challenge}` asks for the second step (no cookie
 * was issued). Anything else is unexpected and throws, so a page never treats it as signed in.
 */
export function signInResult(value: unknown): SignInResult {
  const result = value && typeof value === "object" ? value as Record<string, unknown> : {};
  if (result.twoFactorRequired === true) {
    if (typeof result.challenge !== "string" || !TICKET.test(result.challenge)) throw new Error("Unexpected sign-in response");
    return { kind: "two-factor", challenge: result.challenge, returnPath: optionalPath(result.returnPath) };
  }
  if (typeof result.token === "string" && result.token) return { kind: "session", token: result.token, returnPath: optionalPath(result.returnPath) };
  throw new Error("Unexpected sign-in response");
}

export type SecondFactor = "code" | "recovery";

/** Authenticator code: 6 digits once spaces are removed (apps often show "123 456"). */
export function normalizeTotpInput(value: string): string | null {
  const code = value.replace(/\s+/g, "");
  return /^\d{6}$/.test(code) ? code : null;
}

/** Recovery code: 10 letters/digits once spaces and hyphens are removed; sent as typed (the server normalises). */
export function normalizeRecoveryInput(value: string): string | null {
  const trimmed = value.trim();
  return /^[A-Za-z0-9]{10}$/.test(trimmed.replace(/[\s-]+/g, "")) ? trimmed : null;
}

/** Body of `POST /authorize/login/two-factor`, exactly one factor; null when the input is malformed. */
export function twoFactorLoginBody(challenge: string, factor: SecondFactor, input: string):
  { challenge: string; code: string } | { challenge: string; recoveryCode: string } | null {
  if (!TICKET.test(challenge)) return null;
  if (factor === "code") {
    const code = normalizeTotpInput(input);
    return code ? { challenge, code } : null;
  }
  const recoveryCode = normalizeRecoveryInput(input);
  return recoveryCode ? { challenge, recoveryCode } : null;
}

/** A factor for the signed-in two-factor endpoints (`disable`, `recovery-codes`), plus the optional password. */
export function factorBody(factor: SecondFactor, input: string, password: string):
  Record<string, string> | null {
  const value = factor === "code" ? normalizeTotpInput(input) : normalizeRecoveryInput(input);
  if (!value) return null;
  return { ...(password ? { password } : {}), ...(factor === "code" ? { code: value } : { recoveryCode: value }) };
}

/** Codes the account-security endpoints document (wp3.3b contract). */
const KNOWN_CODES = new Set([
  "TWO_FACTOR_UNAVAILABLE", "TWO_FACTOR_DISABLED", "TWO_FACTOR_ALREADY_ENABLED", "TWO_FACTOR_NOT_ENABLED", "TWO_FACTOR_NOT_PENDING",
  "TWO_FACTOR_CODE_INVALID", "TWO_FACTOR_CHALLENGE_INVALID", "RECENT_AUTHENTICATION_REQUIRED", "RECENT_AUTHENTICATION_FAILED",
  "MAGIC_LINK_DISABLED", "ACCOUNT_DELETION_DISABLED", "ACCOUNT_DELETION_PENDING", "ACCOUNT_DELETION_CONFIRM_MISMATCH",
  "ACCOUNT_HAS_ACTIVE_SUBSCRIPTION", "ACCOUNT_HAS_OPEN_REFUND", "ACCOUNT_LAST_SUPERADMIN", "ACCOUNT_DELETION_NOT_PENDING",
]);
export type AccountSecurityCode =
  | "TWO_FACTOR_UNAVAILABLE" | "TWO_FACTOR_DISABLED" | "TWO_FACTOR_ALREADY_ENABLED" | "TWO_FACTOR_NOT_ENABLED" | "TWO_FACTOR_NOT_PENDING"
  | "TWO_FACTOR_CODE_INVALID" | "TWO_FACTOR_CHALLENGE_INVALID" | "RECENT_AUTHENTICATION_REQUIRED" | "RECENT_AUTHENTICATION_FAILED"
  | "MAGIC_LINK_DISABLED" | "ACCOUNT_DELETION_DISABLED" | "ACCOUNT_DELETION_PENDING" | "ACCOUNT_DELETION_CONFIRM_MISMATCH"
  | "ACCOUNT_HAS_ACTIVE_SUBSCRIPTION" | "ACCOUNT_HAS_OPEN_REFUND" | "ACCOUNT_LAST_SUPERADMIN" | "ACCOUNT_DELETION_NOT_PENDING";

interface FailureShape {
  status?: unknown; _httpStatus?: unknown; code?: unknown; details?: unknown;
  response?: { status?: unknown; data?: { code?: unknown; result?: { details?: unknown } } };
}

/** Status and trusted code of an `httpClient` failure (codes are flattened onto the error; the envelope is kept in `response.data`). */
export function securityFailure(error: unknown): { status?: number; code?: AccountSecurityCode } {
  const value = (error ?? {}) as FailureShape;
  const rawStatus = typeof value.status === "number" ? value.status : typeof value._httpStatus === "number" ? value._httpStatus : value.response?.status;
  const status = typeof rawStatus === "number" ? rawStatus : undefined;
  const raw = value.response?.data?.code ?? value.code;
  const code = typeof raw === "string" && KNOWN_CODES.has(raw) ? raw as AccountSecurityCode : undefined;
  return { status, code };
}

/** `executeAfter` (ISO) of a 403 `ACCOUNT_DELETION_PENDING`, or null. Reads `result.details` of the envelope, then flattened `details`. */
export function deletionPendingUntil(error: unknown): string | null {
  if (securityFailure(error).code !== "ACCOUNT_DELETION_PENDING") return null;
  const value = (error ?? {}) as FailureShape;
  for (const details of [value.response?.data?.result?.details, value.details]) {
    const executeAfter = details && typeof details === "object" ? (details as Record<string, unknown>).executeAfter : undefined;
    if (typeof executeAfter === "string" && Number.isFinite(Date.parse(executeAfter))) return executeAfter;
  }
  return "";
}

/** Copy keys for a failed second sign-in step. `restart` means the challenge is gone: start sign-in again. */
export function twoFactorStepFailure(error: unknown): "codeInvalid" | "restart" | "tooManyRequests" | "unavailable" | "failed" {
  const { status, code } = securityFailure(error);
  if (code === "TWO_FACTOR_CHALLENGE_INVALID") return "restart";
  if (code === "TWO_FACTOR_CODE_INVALID" || status === 401) return "codeInvalid";
  if (status === 429) return "tooManyRequests";
  if (code === "TWO_FACTOR_UNAVAILABLE" || status === 503) return "unavailable";
  return "failed";
}

export type TwoFactorSettingsFailure = "recentRequired" | "recentFailed" | "codeInvalid" | "alreadyEnabled" | "notEnabled" | "notPending"
  | "disabled" | "unavailable" | "tooManyRequests" | "failed";
/** Copy key for a failed signed-in two-factor action (enrol, confirm, disable, recovery codes). */
export function twoFactorSettingsFailure(error: unknown): TwoFactorSettingsFailure {
  const { status, code } = securityFailure(error);
  switch (code) {
    case "RECENT_AUTHENTICATION_REQUIRED": return "recentRequired";
    case "RECENT_AUTHENTICATION_FAILED": return "recentFailed";
    case "TWO_FACTOR_CODE_INVALID": return "codeInvalid";
    case "TWO_FACTOR_ALREADY_ENABLED": return "alreadyEnabled";
    case "TWO_FACTOR_NOT_ENABLED": return "notEnabled";
    case "TWO_FACTOR_NOT_PENDING": return "notPending";
    case "TWO_FACTOR_DISABLED": return "disabled";
    case "TWO_FACTOR_UNAVAILABLE": return "unavailable";
  }
  if (status === 429) return "tooManyRequests";
  if (status === 503) return "unavailable";
  return "failed";
}

export type DeletionFailure = "mismatch" | "activeSubscription" | "openRefund" | "lastSuperadmin" | "disabled" | "recentRequired"
  | "recentFailed" | "tooManyRequests" | "failed";
/** Copy key for a refused `POST /authorize/deletion`. */
export function deletionFailure(error: unknown): DeletionFailure {
  const { status, code } = securityFailure(error);
  switch (code) {
    case "ACCOUNT_DELETION_CONFIRM_MISMATCH": return "mismatch";
    case "ACCOUNT_HAS_ACTIVE_SUBSCRIPTION": return "activeSubscription";
    case "ACCOUNT_HAS_OPEN_REFUND": return "openRefund";
    case "ACCOUNT_LAST_SUPERADMIN": return "lastSuperadmin";
    case "ACCOUNT_DELETION_DISABLED": return "disabled";
    case "RECENT_AUTHENTICATION_REQUIRED": return "recentRequired";
    case "RECENT_AUTHENTICATION_FAILED": return "recentFailed";
  }
  return status === 429 ? "tooManyRequests" : "failed";
}

/** Only a TOTP provisioning URI may become a link (it is rendered as an `href`). */
export function safeOtpauthUri(value: unknown): string | null {
  return typeof value === "string" && value.length <= 2048 && /^otpauth:\/\/totp\/[^\s"<>]+$/.test(value) ? value : null;
}

/** Setup key in groups of four for reading aloud or typing; the raw key stays copyable. */
export function groupSecret(secret: string): string {
  return secret.replace(/\s+/g, "").replace(/(.{4})(?=.)/g, "$1 ");
}

/** Plain-text download of freshly issued recovery codes. */
export function recoveryCodesFile(codes: readonly string[], account: string, issuedAt: Date): string {
  return [`Recovery codes for ${account}`, `Issued ${issuedAt.toISOString()}`, "Each code can be used once.", "", ...codes, ""].join("\n");
}

/** Public projection of the `account` policy from `GET /site/public/config`. Unknown values fall back to the server defaults. */
export interface AccountSecurityPolicy { twoFactorEnabled: boolean; magicLinkEnabled: boolean; deletionEnabled: boolean; deletionGraceDays: number }
export const DEFAULT_ACCOUNT_SECURITY_POLICY: AccountSecurityPolicy = { twoFactorEnabled: true, magicLinkEnabled: false, deletionEnabled: true, deletionGraceDays: 7 };
export function accountSecurityPolicy(config: unknown): AccountSecurityPolicy {
  const values = (config as { policies?: Record<string, { values?: Record<string, unknown> }> } | null)?.policies?.account?.values ?? {};
  const flag = (key: keyof AccountSecurityPolicy) => typeof values[key] === "boolean" ? values[key] as boolean : DEFAULT_ACCOUNT_SECURITY_POLICY[key] as boolean;
  const grace = values.deletionGraceDays;
  return {
    twoFactorEnabled: flag("twoFactorEnabled"),
    magicLinkEnabled: flag("magicLinkEnabled"),
    deletionEnabled: flag("deletionEnabled"),
    deletionGraceDays: typeof grace === "number" && Number.isInteger(grace) && grace >= 0 && grace <= 60 ? grace : DEFAULT_ACCOUNT_SECURITY_POLICY.deletionGraceDays,
  };
}

/**
 * Reads one ticket-shaped value from a URL fragment (`#ticket=…`, `#cancel-deletion=…`). Fragments never
 * reach the server; the page removes it from the address bar before any request.
 */
export function fragmentTicket(hash: string, key: string): string {
  const value = new URLSearchParams(hash.replace(/^#/, "")).get(key) ?? "";
  return TICKET.test(value) ? value : "";
}

/** Login screen steps. */
export type LoginStep =
  | { step: "credentials" }
  | { step: "two-factor"; challenge: string }
  | { step: "deletion-pending"; executeAfter: string };
export type LoginEvent =
  | { type: "result"; result: SignInResult }
  | { type: "failure"; error: unknown }
  | { type: "restart" };
/** Next step after a login response; a session result returns to credentials (the page navigates away). */
export function loginStep(state: LoginStep, event: LoginEvent): LoginStep {
  if (event.type === "restart") return { step: "credentials" };
  if (event.type === "result") return event.result.kind === "two-factor" ? { step: "two-factor", challenge: event.result.challenge } : { step: "credentials" };
  const executeAfter = deletionPendingUntil(event.error);
  return executeAfter === null ? state : { step: "deletion-pending", executeAfter };
}

/* ---------------------------------- OAuth popup ---------------------------------- */

/** sessionStorage key of the popup window: set by /oauth/popup, read once by /oauth/callback. */
export const OAUTH_POPUP_STATE_KEY = "zucker-oauth-popup-state";
const POPUP_STATE = /^[A-Za-z0-9_-]{32,128}$/;
const PROVIDERS = ["google", "github"] as const;
export type PopupProvider = (typeof PROVIDERS)[number];

/** Unguessable channel state (24 random bytes, base64url). */
export function newPopupState(random: (bytes: Uint8Array) => Uint8Array = bytes => crypto.getRandomValues(bytes)): string {
  const bytes = random(new Uint8Array(24));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Fragment of the popup start page: `provider`, `state`, `returnPath`. Nothing secret: the state only names the channel. */
export function popupStartFragment(provider: PopupProvider, state: string, returnPath: string): string {
  return new URLSearchParams({ provider, state, returnPath }).toString();
}
export function parsePopupStart(hash: string): { provider: PopupProvider; state: string; returnPath: string } | null {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const provider = params.get("provider"), state = params.get("state") ?? "", returnPath = params.get("returnPath") ?? "/account";
  if (!PROVIDERS.includes(provider as PopupProvider) || !POPUP_STATE.test(state)) return null;
  if (!returnPath.startsWith("/") || returnPath.startsWith("//") || /[\\\u0000-\u001f]/.test(returnPath) || returnPath.length > 512) return null;
  return { provider: provider as PopupProvider, state, returnPath };
}
export function isPopupState(value: unknown): value is string {
  return typeof value === "string" && POPUP_STATE.test(value);
}

/** Popup failure codes the opener explains; others become the generic OAuth failure. */
export function popupFailureKey(code: string): "oauthExpired" | "oauthAccountExists" | "tooManyRequests" | "oauthFailed" {
  return code === "oauthExpired" || code === "oauthAccountExists" || code === "tooManyRequests" ? code : "oauthFailed";
}
