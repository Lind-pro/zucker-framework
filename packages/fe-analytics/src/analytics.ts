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
}

let config: Required<AnalyticsConfig> = {
  endpoint: '/api/analytics/events',
  batchSize: 10,
  flushInterval: 30000,
  enabled: true,
  getSessionId: () => {
    let sessionId = sessionStorage.getItem('analytics_session_id');
    if (!sessionId) {
      sessionId = `s_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      sessionStorage.setItem('analytics_session_id', sessionId);
    }
    return sessionId;
  },
};

let eventQueue: AnalyticsEvent[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;

/** Initialize or update the analytics configuration. Restarts the flush timer if enabled. */
export function configureAnalytics(options: AnalyticsConfig): void {
  config = { ...config, ...options };

  if (flushTimer) {
    clearInterval(flushTimer);
  }

  if (config.enabled && config.flushInterval > 0) {
    flushTimer = setInterval(flushEvents, config.flushInterval);
  }
}

/** Track a custom event. Events are batched and flushed periodically or when the batch size is reached. */
export function trackEvent(
  eventName: string,
  eventData?: Record<string, unknown>,
): void {
  if (!config.enabled) return;

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

  if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
    navigator.sendBeacon(config.endpoint, JSON.stringify(events));
  } else if (typeof fetch !== 'undefined') {
    fetch(config.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(events),
      keepalive: true,
    }).catch(() => {
      // 静默失败，不影响用户体验
    });
  }
}

// 页面卸载时发送剩余事件
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', flushEvents);
  window.addEventListener('pagehide', flushEvents);
}
