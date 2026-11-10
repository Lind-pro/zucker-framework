import { configureAnalytics, trackEvent, trackPageView, flushEvents, sanitizeReferrer } from './analytics';

/** Same-origin beacons carry a JSON Blob; cross-origin ones a string. */
async function beaconJson(payload: Blob | string) {
  return JSON.parse(typeof payload === 'string' ? payload : await payload.text());
}

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

  it('should queue events and flush via sendBeacon', async () => {
    trackEvent('click', { button: 'submit' });
    trackEvent('hover');
    flushEvents();

    expect(sendBeaconSpy).toHaveBeenCalledTimes(1);
    const payload = await beaconJson(sendBeaconSpy.mock.calls[0][1]);
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

  it('trackPageView should create a page_view event', async () => {
    trackPageView('/home');
    flushEvents();

    const payload = await beaconJson(sendBeaconSpy.mock.calls[0][1]);
    expect(payload[0].eventName).toBe('page_view');
    expect(payload[0].eventData).toMatchObject({ path: '/home' });
  });

  it('should include timestamp in events', async () => {
    const now = Date.now();
    trackEvent('test');
    flushEvents();
    const payload = await beaconJson(sendBeaconSpy.mock.calls[0][1]);
    expect(payload[0].timestamp).toBeGreaterThanOrEqual(now);
  });

  it('types same-origin beacons as JSON and keeps cross-origin beacons CORS-safelisted', async () => {
    trackEvent('same-origin');
    flushEvents();
    const sameOrigin = sendBeaconSpy.mock.calls[0][1] as Blob;
    expect(sameOrigin).toBeInstanceOf(Blob);
    expect(sameOrigin.type).toBe('application/json');
    configureAnalytics({ endpoint: 'https://collector.example/events' });
    trackEvent('cross-origin');
    flushEvents();
    expect(typeof sendBeaconSpy.mock.calls[1][1]).toBe('string');
  });

  it('strips query and fragment from the referrer by default', async () => {
    vi.spyOn(document, 'referrer', 'get').mockReturnValue(
      'https://accounts.example/callback?code=secret-code&state=s#frag',
    );
    trackEvent('after-login');
    flushEvents();
    const payload = await beaconJson(sendBeaconSpy.mock.calls[0][1]);
    expect(payload[0].referrer).toBe('https://accounts.example/callback');
    expect(sanitizeReferrer('https://a.example/p?x=1', 'origin')).toBe('https://a.example');
    expect(sanitizeReferrer('https://a.example/p?x=1', 'full')).toBe('https://a.example/p?x=1');
    expect(sanitizeReferrer('https://a.example/p?x=1', 'none')).toBe('');
    expect(sanitizeReferrer('javascript:alert(1)')).toBe('');
  });
});
