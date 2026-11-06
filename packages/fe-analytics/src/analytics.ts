/** Represents a single analytics event to be tracked and sent to the backend. */
export interface AnalyticsEvent {
  eventName: string;
  eventData?: Record<string, unknown>;
  path: string;
  referrer: string;
  sessionId: string;
  timestamp: number;
}

/** Configuration options for the analytics module. */
export interface AnalyticsConfig {
  endpoint?: string;
  batchSize?: number;
  flushInterval?: number;
  enabled?: boolean;
  getSessionId?: () => string;
  sessionStorageKey?: string;
  createSessionId?: () => string;
  /** Dynamic headers require fetch because sendBeacon cannot carry authorization headers. */
  getHeaders?: () => Record<string, string>;
  /** Adapt the wire payload without changing which fields the consumer collects. */
  serializeEvents?: (events: AnalyticsEvent[]) => string;
}

let cachedSessionId: string | null = null;

function getStoredSessionId(): string {
  if (cachedSessionId) return cachedSessionId;
  try {
    cachedSessionId = sessionStorage.getItem(config.sessionStorageKey);
  } catch {
    // Blocked storage must not interrupt the action being tracked.
  }
  if (!cachedSessionId) {
    cachedSessionId = config.createSessionId();
    try {
      sessionStorage.setItem(config.sessionStorageKey, cachedSessionId);
    } catch {
      // The in-memory identifier remains stable for this page.
    }
  }
  return cachedSessionId;
}

let config: Required<Omit<AnalyticsConfig, 'getHeaders'>> & Pick<AnalyticsConfig, 'getHeaders'> = {
  endpoint: '/api/analytics/events',
  batchSize: 10,
  flushInterval: 30000,
  enabled: true,
  getSessionId: getStoredSessionId,
  sessionStorageKey: 'analytics_session_id',
  createSessionId: () => `s_${Date.now()}_${Math.random().toString(36).slice(2)}`,
  serializeEvents: JSON.stringify,
};

let eventQueue: AnalyticsEvent[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;

/** Initialize or update the analytics configuration. Restarts the flush timer if enabled. */
export function configureAnalytics(options: AnalyticsConfig): void {
  if (
    options.sessionStorageKey !== undefined &&
    options.sessionStorageKey !== config.sessionStorageKey
  ) {
    cachedSessionId = null;
  }
  config = { ...config, ...options };

  if (flushTimer) {
    clearInterval(flushTimer);
  }

  if (config.enabled && config.flushInterval > 0) {
    flushTimer = setInterval(flushEvents, config.flushInterval);
  }
}

/** Track a custom event. Events are batched and flushed periodically or when the batch size is reached. */
export function trackEvent(eventName: string, eventData?: Record<string, unknown>): void {
  if (!config.enabled || typeof window === 'undefined') return;

  const event: AnalyticsEvent = {
    eventName,
    eventData,
    path: typeof window !== 'undefined' ? window.location.pathname : '',
    referrer: typeof document !== 'undefined' ? document.referrer : '',
    sessionId: config.getSessionId(),
    timestamp: Date.now(),
  };

  eventQueue.push(event);

  if (eventQueue.length >= config.batchSize) {
    flushEvents();
  }
}

/** Track a page view event. Uses the current window pathname if no path is provided. */
export function trackPageView(path?: string): void {
  trackEvent('page_view', {
    path: path || (typeof window !== 'undefined' ? window.location.pathname : ''),
    title: typeof document !== 'undefined' ? document.title : '',
  });
}

/** Immediately send all queued events to the analytics endpoint. Uses `sendBeacon` when available. */
export function flushEvents(): void {
  if (eventQueue.length === 0) return;

  const events = [...eventQueue];
  eventQueue = [];

  try {
    const body = config.serializeEvents(events);
    if (!config.getHeaders && typeof navigator !== 'undefined' && navigator.sendBeacon) {
      if (navigator.sendBeacon(config.endpoint, body)) return;
    }
    if (typeof fetch === 'undefined') return;
    void fetch(config.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...config.getHeaders?.() },
      body,
      keepalive: true,
    }).catch(() => {
      // 静默失败，不影响用户体验
    });
  } catch {
    // Serialization, storage or transport failures never block application behavior.
  }
}

// 页面卸载时发送剩余事件
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', flushEvents);
  window.addEventListener('pagehide', flushEvents);
}

/**
 * A product's closed list of event names. `track` only accepts listed names, so
 * a renamed or misspelled event fails type checking instead of silently
 * splitting a metric; `has` lets the receiving server drop unknown names.
 */
export function defineEventCatalog<const Names extends readonly string[]>(names: Names) {
  const known = new Set<string>(names);
  if (known.size !== names.length) throw new Error('Analytics event names must be unique');
  return {
    names,
    has: (name: string): name is Names[number] => known.has(name),
    track: (name: Names[number], eventData?: Record<string, unknown>) => trackEvent(name, eventData),
  };
}
