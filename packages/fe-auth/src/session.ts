/**
 * Session binding for browser clients.
 *
 * A signed-in tab may receive new access tokens from refresh or response headers. Those may
 * rotate credentials, but must never move the tab to a different session; and requests started
 * for one session must not complete into another. Decoding a token here only *identifies* a
 * session for comparison; it never authorizes anything (the server remains authoritative).
 */

/** Minimal view of an auth store; compatible with createAuthStore state. */
export interface SessionSnapshot {
  token: string | null;
  user: { id: string } | null;
}

/** Returns a stable key for the session a token belongs to, or null when it cannot be identified. */
export type SessionKey = (token: string) => string | null;

const MAX_PAYLOAD_LENGTH = 8192;

function decodePayload(token: string): Record<string, unknown> | null {
  const payload = token.split('.')[1];
  if (!payload || payload.length > MAX_PAYLOAD_LENGTH) return null;
  try {
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const value: unknown = JSON.parse(atob(base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=')));
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/**
 * Identify a session by JWT claims chosen by the application (e.g. subject, session id and
 * credential version). Each claim must be a non-empty string or a safe integer; otherwise the
 * token is unidentifiable and comparison falls back to the exact token.
 */
export function jwtSessionKey(claims: readonly string[]): SessionKey {
  if (!claims.length) throw new Error('jwtSessionKey requires at least one claim');
  return (token) => {
    const payload = decodePayload(token);
    if (!payload) return null;
    const values: Array<string | number> = [];
    for (const claim of claims) {
      const value = payload[claim];
      if ((typeof value === 'string' && value) || Number.isSafeInteger(value)) values.push(value as string | number);
      else return null;
    }
    return JSON.stringify(values);
  };
}

/** Identity of the signed-in user and session; changes whenever either changes. */
export function sessionIdentity(state: SessionSnapshot, key: SessionKey): string {
  return JSON.stringify([state.user?.id ?? null, state.token ? key(state.token) ?? state.token : null]);
}

/** Whether a newly received token may replace the current one: same session, different credential. */
export function acceptsSessionToken(state: SessionSnapshot, token: string, key: SessionKey): boolean {
  if (!state.user || !state.token || !token) return false;
  const current = key(state.token);
  return current !== null ? current === key(token) : state.token === token;
}

/**
 * Bind request cancellation to the current session: signal() returns an AbortSignal that is
 * aborted as soon as the user or session changes, while ordinary token rotation inside the same
 * session keeps in-flight requests alive.
 */
export function createSessionRequestScope(
  read: () => SessionSnapshot,
  subscribe: (listener: () => void) => () => void,
  key: SessionKey,
) {
  let identity = sessionIdentity(read(), key);
  let controller = new AbortController();
  const update = () => {
    const next = sessionIdentity(read(), key);
    if (next === identity) return;
    const previous = controller;
    identity = next;
    controller = new AbortController();
    previous.abort();
  };
  const unsubscribe = subscribe(update);
  return {
    signal: () => { update(); return controller.signal; },
    dispose: () => { unsubscribe(); controller.abort(); },
  };
}
