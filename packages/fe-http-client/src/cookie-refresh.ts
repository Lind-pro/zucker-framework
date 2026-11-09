/**
 * Cookie refresh that survives navigation.
 *
 * Servers that rotate the refresh token as soon as they accept `POST <refresh>` deliver the new
 * token only in that response's `Set-Cookie`. If a page unload (reload, link, typed URL) cancels
 * the request after the server rotated but before the response arrived, the browser keeps the old
 * cookie, and the next exchange is rejected as a replay — the user is signed out. Two measures close
 * that window without weakening the server's replay protection:
 *
 * 1. `createKeepaliveCookieRefresh` uses `fetch(..., { keepalive: true })`, so the browser completes
 *    the exchange and stores the rotated cookie even after the document that started it is gone.
 * 2. `createRefreshExchange` records a short-lived marker in localStorage while an exchange is in
 *    flight. When the document unloads (`pagehide`) during an exchange, the marker is flagged as
 *    interrupted. The next document honors only an interrupted marker left by another document and
 *    younger than the grace period: it then retries a 401 with backoff until the rotated cookie has
 *    arrived. A concurrent exchange in another live tab is never mistaken for an interrupted one.
 *
 * A replayed token is still rejected by the server on every attempt; the client only waits.
 */
export type RefreshTransport = (signal?: AbortSignal) => Promise<{ access_token: string }>;

/** Thrown when a refresh attempt exceeds its timeout. It carries no HTTP status (unknown outcome). */
export class RefreshTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Refresh did not complete within ${timeoutMs} ms`);
    this.name = 'RefreshTimeoutError';
  }
}

type MarkerStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface RefreshExchangeOptions {
  transport: RefreshTransport;
  /** localStorage key of the in-flight marker; shared by tabs that share the refresh cookie. */
  markerKey: string;
  /** How long after an interrupted exchange started a 401 is retried (default 10 s). */
  graceMs?: number;
  /** Per-attempt timeout; the attempt is aborted and fails without a status (default 15 s). */
  timeoutMs?: number;
  /** Storage for the marker (default `localStorage` when available; `null` disables it). */
  storage?: MarkerStorage | null;
  /** Identity of this document (default: random per module instance, i.e. per page load). */
  documentId?: string;
  /** Where `pagehide` is observed (default `window` when available; `null` disables it). */
  events?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> | null;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface Marker {
  id: string;
  documentId: string;
  startedAt: number;
  interrupted?: boolean;
}

export const DEFAULT_REFRESH_GRACE_MS = 10_000;
export const DEFAULT_REFRESH_TIMEOUT_MS = 15_000;

function randomId(): string {
  const source = typeof crypto !== 'undefined' ? crypto : undefined;
  if (source && typeof source.randomUUID === 'function') return source.randomUUID();
  if (source && typeof source.getRandomValues === 'function')
    return Array.from(source.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');
  // Not a secret: only distinguishes markers of concurrent documents.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

const DOCUMENT_ID = randomId();

function defaultStorage(): MarkerStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    // Storage can be blocked (privacy settings); the exchange still works without the marker.
    return null;
  }
}

/** HTTP status carried by an error (`status` or axios-style `response.status`). */
export function refreshErrorStatus(error: unknown): number | undefined {
  const value = error as { status?: unknown; response?: { status?: unknown } } | null;
  const status = value?.status ?? value?.response?.status;
  return typeof status === 'number' ? status : undefined;
}

/** Run one attempt with a timeout that aborts the transport and rejects without a status. */
function attemptWithTimeout(transport: RefreshTransport, timeoutMs: number): Promise<{ access_token: string }> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new RefreshTimeoutError(timeoutMs);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  return Promise.race([transport(controller.signal), timeout]).finally(() => clearTimeout(timer));
}

/** Wrap a refresh transport with the interrupted-exchange marker, a timeout and bounded 401 retry. */
export function createRefreshExchange(options: RefreshExchangeOptions): () => Promise<{ access_token: string }> {
  const storage = options.storage === undefined ? defaultStorage() : options.storage;
  const graceMs = options.graceMs ?? DEFAULT_REFRESH_GRACE_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_REFRESH_TIMEOUT_MS;
  const documentId = options.documentId ?? DOCUMENT_ID;
  const events = options.events === undefined ? (typeof window === 'undefined' ? null : window) : options.events;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const read = (): Marker | null => {
    try {
      const value = JSON.parse(storage?.getItem(options.markerKey) ?? 'null') as Marker | null;
      return value && typeof value.id === 'string' && typeof value.documentId === 'string' && Number.isFinite(value.startedAt)
        ? value
        : null;
    } catch {
      return null;
    }
  };
  const write = (marker: Marker) => {
    try {
      storage?.setItem(options.markerKey, JSON.stringify(marker));
    } catch {
      // Best effort: without the marker an interrupted exchange is not retried, nothing else changes.
    }
  };
  const clear = (id: string) => {
    try {
      if (read()?.id === id) storage?.removeItem(options.markerKey);
    } catch {
      // See write().
    }
  };

  // Unloading while an exchange of this document is unresolved: flag its marker so the next document
  // waits for it. Registered for the document's lifetime, because the browser may reject the page's
  // fetch promise as navigation starts, before `pagehide`; a marker still present then is exactly an
  // exchange without an HTTP answer (any answer clears it).
  events?.addEventListener('pagehide', () => {
    const current = read();
    if (current && current.documentId === documentId && !current.interrupted) write({ ...current, interrupted: true });
  });

  return async () => {
    const previous = read();
    const own: Marker = { id: randomId(), documentId, startedAt: now() };
    write(own);
    // Only an exchange cut off by another document's unload, and recent, can still be completing.
    const retryUntil =
      previous?.interrupted === true && previous.documentId !== documentId && previous.startedAt <= own.startedAt
        ? previous.startedAt + graceMs
        : 0;
    let delay = 250;
    for (;;) {
      try {
        const result = await attemptWithTimeout(options.transport, timeoutMs);
        clear(own.id);
        return result;
      } catch (error) {
        const status = refreshErrorStatus(error);
        // Without an HTTP status the outcome is unknown (navigation, network, timeout): the marker
        // stays and expires with the grace period. An HTTP answer means nothing of ours is in flight.
        if (status === undefined || status !== 401 || now() + delay > retryUntil) {
          if (status !== undefined) clear(own.id);
          throw error;
        }
        await sleep(delay);
        delay = Math.min(delay * 2, 2000);
      }
    }
  };
}

export interface KeepaliveCookieRefreshOptions {
  /** Default `globalThis.fetch`. */
  fetch?: typeof fetch;
}

/**
 * Cookie refresh over `fetch` with `keepalive`, so the browser finishes the exchange (and stores the
 * rotated HttpOnly cookie) even when the page that started it unloads. Every error that follows an
 * HTTP answer carries `status` (including a malformed 200), so callers can tell it from an unknown
 * outcome. Accepts `{ access_token }` or a `{ result: { access_token } }` envelope.
 */
export function createKeepaliveCookieRefresh(url: string, options: KeepaliveCookieRefreshOptions = {}): RefreshTransport {
  return async (signal) => {
    const fetcher = options.fetch ?? globalThis.fetch;
    const response = await fetcher(url, {
      method: 'POST',
      credentials: 'include',
      keepalive: true,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: '{}',
      ...(signal ? { signal } : {}),
    });
    let data: unknown = null;
    try {
      data = await response.json();
    } catch {
      // Non-JSON bodies are handled by the status check below.
    }
    if (!response.ok) {
      const message = (data as { message?: unknown } | null)?.message;
      throw Object.assign(new Error(typeof message === 'string' ? message : `Refresh failed (${response.status})`), {
        status: response.status,
      });
    }
    const body = data as { result?: { access_token?: unknown }; access_token?: unknown } | null;
    const token = (body?.result ?? body)?.access_token;
    if (typeof token !== 'string' || !token)
      throw Object.assign(new Error('Invalid access-token refresh response'), { status: response.status });
    return { access_token: token };
  };
}

/** One signal aborted when any input aborts (`AbortSignal.any` with a fallback). */
export function combineAbortSignals(signals: ReadonlyArray<AbortSignal | undefined>): AbortSignal | undefined {
  const present = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (present.length <= 1) return present[0];
  const anyFn = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  if (anyFn) return anyFn(present);
  const controller = new AbortController();
  for (const signal of present) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}
