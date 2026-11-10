/**
 * First-touch acquisition source for sign-up attribution. Stored in localStorage (never a cookie, so
 * public responses stay cookie-free and cacheable) the first time a visitor lands with
 * `?utm_source=`, and sent once as `utm` with the registration request. The Server sanitises again.
 * Relative imports only: node tests load this module directly.
 */
export const UTM_STORAGE_KEY = 'zucker.first-touch-utm';
/** Attribution window: an older first touch is ignored and may be replaced. */
export const UTM_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const UTM_SOURCE = /^[A-Za-z0-9_.-]{1,64}$/;

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>;

export function sanitizeUtmSource(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return UTM_SOURCE.test(trimmed) ? trimmed : null;
}

function browserStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Stored source when still inside the attribution window, else null. */
export function readUtmSource(storage: Storage | null = browserStorage(), now = Date.now()): string | null {
  try {
    const saved = JSON.parse(storage?.getItem(UTM_STORAGE_KEY) ?? 'null') as { source?: unknown; at?: unknown } | null;
    if (!saved || typeof saved.at !== 'number' || now - saved.at > UTM_MAX_AGE_MS || saved.at > now) return null;
    return sanitizeUtmSource(saved.source);
  } catch {
    return null;
  }
}

/** Records `utm_source` from a query string unless a first touch is already recorded. */
export function captureUtmSource(search: string, storage: Storage | null = browserStorage(), now = Date.now()): void {
  if (!storage || readUtmSource(storage, now)) return;
  const source = sanitizeUtmSource(new URLSearchParams(search).get('utm_source'));
  if (!source) return;
  try {
    storage.setItem(UTM_STORAGE_KEY, JSON.stringify({ source, at: now }));
  } catch {
    /* Storage can be denied by browser policy; attribution is optional. */
  }
}
