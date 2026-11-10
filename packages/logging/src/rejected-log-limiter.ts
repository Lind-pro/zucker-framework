/**
 * Bounds how many rejected (4xx/5xx) requests are persisted, so unauthenticated clients probing
 * random paths cannot turn every 404/401/429 into a database insert.
 * Fixed windows keyed by status + client IP, plus a global ceiling per window.
 */
export interface RejectedLogRateLimitOptions {
  /** Persisted rejections per status and client within one window. Default 20. */
  maxPerKey?: number;
  /** Persisted rejections across all clients within one window. Default 300. */
  maxTotal?: number;
  /** Window length in ms. Default 60_000. */
  windowMs?: number;
}

const MAX_TRACKED_KEYS = 10_000;

export class RejectedLogRateLimiter {
  private readonly maxPerKey: number;
  private readonly maxTotal: number;
  private readonly windowMs: number;
  private windowStart = 0;
  private total = 0;
  private suppressed = 0;
  private readonly counts = new Map<string, number>();

  constructor(options: RejectedLogRateLimitOptions = {}, private readonly now: () => number = Date.now) {
    this.maxPerKey = positiveInteger(options.maxPerKey, 20);
    this.maxTotal = positiveInteger(options.maxTotal, 300);
    this.windowMs = positiveInteger(options.windowMs, 60_000);
  }

  /** True when this rejection may be persisted. */
  allow(statusCode: number, client: string | undefined): boolean {
    const now = this.now();
    if (now - this.windowStart >= this.windowMs) {
      this.windowStart = now;
      this.total = 0;
      this.suppressed = 0;
      this.counts.clear();
    }
    if (this.total >= this.maxTotal) {
      this.suppressed += 1;
      return false;
    }
    const key = `${statusCode}|${client ?? ''}`;
    const count = this.counts.get(key) ?? 0;
    if (count >= this.maxPerKey) {
      this.suppressed += 1;
      return false;
    }
    if (count === 0 && this.counts.size >= MAX_TRACKED_KEYS) {
      this.suppressed += 1;
      return false;
    }
    this.counts.set(key, count + 1);
    this.total += 1;
    return true;
  }

  /** Rejections dropped in the current window (for diagnostics). */
  get suppressedInWindow(): number {
    return this.suppressed;
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
}
