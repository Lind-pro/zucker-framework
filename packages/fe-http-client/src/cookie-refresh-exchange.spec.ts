import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  combineAbortSignals,
  createKeepaliveCookieRefresh,
  createRefreshExchange,
  DEFAULT_REFRESH_GRACE_MS,
  RefreshTimeoutError,
} from './cookie-refresh';

const unauthorized = () => Object.assign(new Error('Invalid or expired session'), { status: 401 });

/**
 * A server with refresh-token rotation and replay denial, and a browser cookie jar. `send` models
 * one request: the server rotates when it accepts the token, but the browser stores the new cookie
 * only when the response is delivered.
 */
function rotatingServer() {
  let current = 'token-0';
  let issued = 0;
  const jar = { cookie: 'token-0' };
  return {
    jar,
    send(options: { deliver: Promise<void> | null } = { deliver: Promise.resolve() }) {
      const presented = jar.cookie;
      if (presented !== current) return Promise.reject(unauthorized());
      const next = `token-${++issued}`;
      current = next; // rotated server-side as soon as the request is accepted
      if (!options.deliver) return new Promise<never>(() => undefined); // response never delivered
      return options.deliver.then(() => {
        jar.cookie = next;
        return { access_token: `access-${issued}` };
      });
    },
  };
}

/** A per-document event target standing in for `window` (pagehide = the document unloads). */
const documentEvents = () => new EventTarget();
const unload = (events: EventTarget) => events.dispatchEvent(new Event('pagehide'));

describe('refresh exchange across navigation', () => {
  let time = 0;
  const now = () => time;
  const sleep = async (ms: number) => {
    time += ms;
  };
  beforeEach(() => {
    localStorage.clear();
    time = 1_000_000;
  });

  it('reproduces the logout: an exchange cut off after rotation leaves a stale cookie and the next one is denied', async () => {
    const server = rotatingServer();
    void server.send({ deliver: null });
    const next = createRefreshExchange({ transport: () => server.send(), markerKey: 'k', storage: null, now, sleep });
    await expect(next()).rejects.toMatchObject({ status: 401 });
  });

  it('retries a denied exchange while an interrupted predecessor document is still completing (keepalive)', async () => {
    const server = rotatingServer();
    let deliver!: () => void;
    const delivered = new Promise<void>((done) => (deliver = done));
    const pageA = documentEvents();
    const documentA = createRefreshExchange({
      transport: () => server.send({ deliver: delivered }),
      markerKey: 'k',
      documentId: 'A',
      events: pageA,
      now,
      sleep,
    });
    void documentA();
    unload(pageA); // A unloads with the exchange in flight
    expect(JSON.parse(localStorage.getItem('k') ?? 'null')).toMatchObject({ documentId: 'A', interrupted: true });
    let attempts = 0;
    const documentB = createRefreshExchange({
      transport: () => {
        if (++attempts === 3) deliver();
        return attempts >= 3 ? delivered.then(() => server.send()) : server.send();
      },
      markerKey: 'k',
      documentId: 'B',
      events: documentEvents(),
      now,
      sleep,
    });
    await expect(documentB()).resolves.toEqual({ access_token: 'access-2' });
    expect(attempts).toBe(3);
    expect(server.jar.cookie).toBe('token-2');
  });

  it('flags the marker even when the browser rejects the fetch before pagehide', async () => {
    const pageA = documentEvents();
    // Navigation starts: the page's fetch promise rejects without an HTTP answer, then the page hides.
    const documentA = createRefreshExchange({ transport: async () => Promise.reject(new TypeError('Failed to fetch')),
      markerKey: 'k', documentId: 'A', events: pageA, now, sleep });
    await expect(documentA()).rejects.toThrow('Failed to fetch');
    unload(pageA);
    expect(JSON.parse(localStorage.getItem('k') ?? 'null')).toMatchObject({ documentId: 'A', interrupted: true });
    // A page that unloads after its exchange was answered leaves nothing to wait for.
    localStorage.clear();
    const pageC = documentEvents();
    await createRefreshExchange({ transport: async () => ({ access_token: 'ok' }), markerKey: 'k', documentId: 'C', events: pageC, now, sleep })();
    unload(pageC);
    expect(localStorage.getItem('k')).toBeNull();
  });

  it('does not wait for a concurrent exchange of another live tab', async () => {
    // Tab A is refreshing (marker present, not interrupted); tab B gets a genuine 401.
    localStorage.setItem('k', JSON.stringify({ id: 'a', documentId: 'A', startedAt: time }));
    const transport = vi.fn(async () => Promise.reject(unauthorized()));
    const started = time;
    await expect(
      createRefreshExchange({ transport, markerKey: 'k', documentId: 'B', events: null, now, sleep })(),
    ).rejects.toMatchObject({ status: 401 });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(time).toBe(started);
  });

  it('ignores an interrupted marker written by the same document', async () => {
    localStorage.setItem('k', JSON.stringify({ id: 'a', documentId: 'B', startedAt: time, interrupted: true }));
    const transport = vi.fn(async () => Promise.reject(unauthorized()));
    await expect(createRefreshExchange({ transport, markerKey: 'k', documentId: 'B', events: null, now, sleep })()).rejects.toMatchObject({
      status: 401,
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('keeps the marker when the request is rejected without an HTTP answer and clears it on any answer', async () => {
    const aborted = createRefreshExchange({
      transport: async () => Promise.reject(new TypeError('Failed to fetch')),
      markerKey: 'k',
      events: null,
      now,
      sleep,
    });
    await expect(aborted()).rejects.toThrow('Failed to fetch');
    expect(JSON.parse(localStorage.getItem('k') ?? 'null')).toMatchObject({ startedAt: time });
    const denied = createRefreshExchange({ transport: async () => Promise.reject(unauthorized()), markerKey: 'k', events: null, now, sleep });
    await expect(denied()).rejects.toMatchObject({ status: 401 });
    expect(localStorage.getItem('k')).toBeNull();
    // A malformed 200 is an HTTP answer too: the marker is cleared.
    const malformed = createRefreshExchange({
      transport: async () => Promise.reject(Object.assign(new Error('Invalid access-token refresh response'), { status: 200 })),
      markerKey: 'k',
      events: null,
      now,
      sleep,
    });
    await expect(malformed()).rejects.toMatchObject({ status: 200 });
    expect(localStorage.getItem('k')).toBeNull();
  });

  it('stops retrying for other errors and at the end of the grace period', async () => {
    const interrupted = () =>
      localStorage.setItem('k', JSON.stringify({ id: 'old', documentId: 'A', startedAt: time, interrupted: true }));
    const failing = vi.fn(async () => Promise.reject(Object.assign(new Error('down'), { status: 503 })));
    interrupted();
    await expect(createRefreshExchange({ transport: failing, markerKey: 'k', documentId: 'B', events: null, now, sleep })()).rejects.toMatchObject({
      status: 503,
    });
    expect(failing).toHaveBeenCalledTimes(1);

    localStorage.setItem('k', JSON.stringify({ id: 'old', documentId: 'A', startedAt: time - DEFAULT_REFRESH_GRACE_MS - 1, interrupted: true }));
    const transport = vi.fn(async () => Promise.reject(unauthorized()));
    const exchange = createRefreshExchange({ transport, markerKey: 'k', documentId: 'B', events: null, now, sleep });
    await expect(exchange()).rejects.toMatchObject({ status: 401 });
    expect(transport).toHaveBeenCalledTimes(1);

    interrupted();
    const started = time;
    await expect(exchange()).rejects.toMatchObject({ status: 401 });
    expect(time - started).toBeLessThanOrEqual(DEFAULT_REFRESH_GRACE_MS);
    expect(transport.mock.calls.length).toBeGreaterThan(3);
    expect(localStorage.getItem('k')).toBeNull();
  });

  it('times out a hanging exchange: aborts the transport, keeps the marker and rejects without a status', async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const exchange = createRefreshExchange({
        transport: (value) => {
          signal = value;
          return new Promise<never>(() => undefined);
        },
        markerKey: 'k',
        timeoutMs: 1000,
        events: null,
      });
      const pending = exchange();
      const outcome = expect(pending).rejects.toBeInstanceOf(RefreshTimeoutError);
      await vi.advanceTimersByTimeAsync(1000);
      await outcome;
      expect(signal?.aborted).toBe(true);
      expect(localStorage.getItem('k')).not.toBeNull();
      expect((await pending.catch((error: unknown) => error)) as { status?: number }).not.toHaveProperty('status');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('keepalive cookie refresh transport', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('posts with credentials and keepalive so an unload cannot cancel the exchange', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ access_token: 'access' }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const controller = new AbortController();
    await expect(createKeepaliveCookieRefresh('/api/authorize/refresh')(controller.signal)).resolves.toEqual({ access_token: 'access' });
    expect(fetch).toHaveBeenCalledWith(
      '/api/authorize/refresh',
      expect.objectContaining({ method: 'POST', credentials: 'include', keepalive: true, signal: controller.signal }),
    );
  });

  it('reports the HTTP status, including for a malformed 200', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ message: 'Invalid or expired session' }), { status: 401 })));
    await expect(createKeepaliveCookieRefresh('/r')()).rejects.toMatchObject({ status: 401, message: 'Invalid or expired session' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    await expect(createKeepaliveCookieRefresh('/r')()).rejects.toMatchObject({ status: 200, message: 'Invalid access-token refresh response' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ result: { access_token: 'wrapped' } }), { status: 200 })));
    await expect(createKeepaliveCookieRefresh('/r')()).resolves.toEqual({ access_token: 'wrapped' });
  });
});

describe('combineAbortSignals', () => {
  it('aborts when any input aborts and passes a single signal through', () => {
    const a = new AbortController();
    const b = new AbortController();
    expect(combineAbortSignals([a.signal, undefined])).toBe(a.signal);
    const combined = combineAbortSignals([a.signal, b.signal]);
    b.abort();
    expect(combined?.aborted).toBe(true);
  });
});
