/**
 * First-touch referral code from `?ref=` (same pattern as `features/landing/utm.ts`). Stored in
 * localStorage, never a cookie, so public responses stay cookie-free and cacheable. The value is a hint
 * only: the Server re-validates it and takes identity from the session when `ReferralClaim` sends it.
 * Relative imports only: node tests load this module directly.
 */
export const REFERRAL_STORAGE_KEY = 'zucker.first-touch-ref';
/** Attribution window: an older first touch is ignored and may be replaced. */
export const REFERRAL_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const CODE = /^[A-Z0-9]{6,16}$/;

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Trimmed and upper-cased; anything but 6–16 characters [A-Z0-9] becomes null. */
export function sanitizeReferralCode(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 64) return null;
  const code = value.trim().toUpperCase();
  return CODE.test(code) ? code : null;
}

function browserStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Stored code when still inside the attribution window, else null. */
export function readReferralCode(storage: Storage | null = browserStorage(), now = Date.now()): string | null {
  try {
    const saved = JSON.parse(storage?.getItem(REFERRAL_STORAGE_KEY) ?? 'null') as { code?: unknown; at?: unknown } | null;
    if (!saved || typeof saved.at !== 'number' || now - saved.at > REFERRAL_MAX_AGE_MS || saved.at > now) return null;
    return sanitizeReferralCode(saved.code);
  } catch {
    return null;
  }
}

/** Records `ref` from a query string unless a first touch inside the window is already recorded. */
export function captureReferralCode(search: string, storage: Storage | null = browserStorage(), now = Date.now()): void {
  if (!storage || readReferralCode(storage, now)) return;
  const code = sanitizeReferralCode(new URLSearchParams(search).get('ref'));
  if (!code) return;
  try {
    storage.setItem(REFERRAL_STORAGE_KEY, JSON.stringify({ code, at: now }));
  } catch {
    /* Storage can be denied by browser policy; referral attribution is optional. */
  }
}

export function clearReferralCode(storage: Storage | null = browserStorage()): void {
  try {
    storage?.removeItem(REFERRAL_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Whether a failed claim should drop the stored code: a definitive refusal (4xx other than 401/429)
 * will not change on retry; rate limits, expired sessions, network and server errors keep it.
 */
export function isFinalClaimFailure(status: number | undefined): boolean {
  return typeof status === 'number' && status >= 400 && status < 500 && status !== 401 && status !== 408 && status !== 429;
}
