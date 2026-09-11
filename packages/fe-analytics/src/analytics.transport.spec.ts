import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

async function createTracker() {
  vi.resetModules();
  const analytics = await import('./analytics');
  analytics.configureAnalytics({
    flushInterval: 0,
    batchSize: 1,
    sessionStorageKey: 'consumer-session',
    createSessionId: () => 'generated-session',
  });
  return analytics;
}

describe('analytics consumer transport', () => {
  const fetcher = vi.fn();
  const beacon = vi.fn();

  beforeEach(() => {
    sessionStorage.clear();
    fetcher.mockReset().mockResolvedValue(new Response());
    beacon.mockReset().mockReturnValue(true);
    vi.stubGlobal('fetch', fetcher);
    vi.stubGlobal('navigator', { sendBeacon: beacon });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('sends a configured single event with the current bearer token and keepalive', async () => {
    sessionStorage.setItem('consumer-session', 'existing-session');
    const { configureAnalytics, trackEvent } = await createTracker();
    let token = 'first-token';
    configureAnalytics({
      endpoint: '/events',
      getHeaders: () => ({ Authorization: `Bearer ${token}` }),
      serializeEvents: ([event]) =>
        JSON.stringify({
          name: event.eventName,
          details: event.eventData,
          sessionId: event.sessionId,
        }),
    });

    trackEvent('completed', { itemId: 'synthetic-item' });
    token = 'refreshed-token';
    trackEvent('closed');

    expect(beacon).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenNthCalledWith(1, '/events', {
      method: 'POST',
      keepalive: true,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer first-token' },
      body: JSON.stringify({
        name: 'completed',
        details: { itemId: 'synthetic-item' },
        sessionId: 'existing-session',
      }),
    });
    expect(fetcher.mock.calls[1][1].headers.Authorization).toBe('Bearer refreshed-token');
  });

  it('preserves anonymous delivery without inventing an authorization value', async () => {
    const { configureAnalytics, trackEvent } = await createTracker();
    configureAnalytics({ getHeaders: () => ({}) });
    trackEvent('anonymous');
    expect(beacon).not.toHaveBeenCalled();
    expect(fetcher.mock.calls[0][1].headers).toEqual({ 'Content-Type': 'application/json' });
    expect(sessionStorage.getItem('consumer-session')).toBe('generated-session');
  });

  it('keeps a stable in-memory session when browser storage is blocked', async () => {
    const { trackEvent } = await createTracker();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => {
      trackEvent('first');
      trackEvent('second');
    }).not.toThrow();
    expect(beacon.mock.calls.map(([, payload]) => JSON.parse(payload)[0].sessionId)).toEqual([
      'generated-session',
      'generated-session',
    ]);
  });

  it('falls back to keepalive fetch if the browser refuses to queue a beacon', async () => {
    const { trackEvent } = await createTracker();
    beacon.mockReturnValue(false);
    trackEvent('last-event');
    expect(fetcher).toHaveBeenCalledWith(
      '/api/analytics/events',
      expect.objectContaining({ keepalive: true }),
    );
  });

  it('does not send events while disabled or during server rendering', async () => {
    const { configureAnalytics, trackEvent } = await createTracker();
    configureAnalytics({ enabled: false });
    trackEvent('disabled');
    configureAnalytics({ enabled: true });
    vi.stubGlobal('window', undefined);
    trackEvent('server-render');
    expect(fetcher).not.toHaveBeenCalled();
    expect(beacon).not.toHaveBeenCalled();
  });

  it('does not throw from failed serialization or transport', async () => {
    const { configureAnalytics, trackEvent } = await createTracker();
    configureAnalytics({ getHeaders: () => ({}) });
    fetcher.mockRejectedValue(new Error('offline'));
    expect(() => trackEvent('offline')).not.toThrow();
    configureAnalytics({
      serializeEvents: () => {
        throw new Error('invalid payload');
      },
    });
    expect(() => trackEvent('invalid')).not.toThrow();
  });
});
