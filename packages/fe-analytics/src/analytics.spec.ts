import { configureAnalytics, trackEvent, trackPageView, flushEvents } from './analytics';

describe('fe-analytics', () => {
  let sendBeaconSpy: ReturnType<typeof vi.fn>;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    sendBeaconSpy = vi.fn().mockReturnValue(true);
    fetchSpy = vi.fn().mockResolvedValue(new Response());

    Object.defineProperty(navigator, 'sendBeacon', {
      value: sendBeaconSpy,
      writable: true,
      configurable: true,
    });
    vi.stubGlobal('fetch', fetchSpy);
    vi.stubGlobal('sessionStorage', {
      _store: {} as Record<string, string>,
      getItem(key: string) { return this._store[key] ?? null; },
      setItem(key: string, val: string) { this._store[key] = val; },
      removeItem(key: string) { delete this._store[key]; },
      clear() { this._store = {}; },
    });

    configureAnalytics({
      enabled: true,
      batchSize: 10,
      flushInterval: 30000,
      endpoint: '/api/analytics/events',
      getSessionId: () => 'test-session',
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('should not track events when disabled', () => {
    configureAnalytics({ enabled: false });
    trackEvent('click');
    flushEvents();
    expect(sendBeaconSpy).not.toHaveBeenCalled();
  });

  it('should queue events and flush via sendBeacon', () => {
    trackEvent('click', { button: 'submit' });
    trackEvent('hover');
    flushEvents();

    expect(sendBeaconSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(sendBeaconSpy.mock.calls[0][1]);
    expect(payload).toHaveLength(2);
    expect(payload[0].eventName).toBe('click');
    expect(payload[0].eventData).toEqual({ button: 'submit' });
    expect(payload[0].sessionId).toBe('test-session');
    expect(payload[1].eventName).toBe('hover');
  });

  it('should auto-flush when batchSize is reached', () => {
    configureAnalytics({ batchSize: 3, getSessionId: () => 'test-session' });
    trackEvent('a');
    trackEvent('b');
    expect(sendBeaconSpy).not.toHaveBeenCalled();
    trackEvent('c');
    expect(sendBeaconSpy).toHaveBeenCalledTimes(1);
  });

  it('should flush on interval', () => {
    configureAnalytics({ flushInterval: 5000, getSessionId: () => 'test-session' });
    trackEvent('tick');
    vi.advanceTimersByTime(5000);
    expect(sendBeaconSpy).toHaveBeenCalled();
  });

  it('should not flush when queue is empty', () => {
    flushEvents();
    expect(sendBeaconSpy).not.toHaveBeenCalled();
  });

  it('should fallback to fetch when sendBeacon is unavailable', () => {
    Object.defineProperty(navigator, 'sendBeacon', {
      value: undefined,
      writable: true,
      configurable: true,
    });
    trackEvent('fallback');
    flushEvents();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe('/api/analytics/events');
  });

  it('trackPageView should create a page_view event', () => {
    trackPageView('/home');
    flushEvents();

    const payload = JSON.parse(sendBeaconSpy.mock.calls[0][1]);
    expect(payload[0].eventName).toBe('page_view');
    expect(payload[0].eventData).toMatchObject({ path: '/home' });
  });

  it('should include timestamp in events', () => {
    const now = Date.now();
    trackEvent('test');
    flushEvents();
    const payload = JSON.parse(sendBeaconSpy.mock.calls[0][1]);
    expect(payload[0].timestamp).toBeGreaterThanOrEqual(now);
  });
});
