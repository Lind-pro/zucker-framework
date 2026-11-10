/**
 * Bounds how many rejected (4xx/5xx) requests are persisted, so unauthenticated clients probing
 * random paths cannot turn every 404/401/429 into a database insert.
 *
 * Fixed windows with separate budgets, so one kind of flood cannot hide another:
 * - per status code and client (`maxPerKey`);
 * - per status code across clients (`maxPerStatus`), so a 404 flood leaves room for 401/403;
 * - all non-5xx statuses together (`maxTotal`);
 * - 5xx on its own budget (`maxServerErrors`), never consumed by 4xx.
 * Dropped rows are counted; `drainSuppressed()` hands the count of a closed window to the caller
 * once, so the gap itself is recorded.
 */
export interface RejectedLogRateLimitOptions {
  /** Persisted rows per status and client within one window. Default 20. */
  maxPerKey?: number;
  /** Persisted rows per status code across all clients within one window. Default 300. */
  maxPerStatus?: number;
  /** Persisted non-5xx rows across all statuses and clients within one window. Default 1200. */
  maxTotal?: number;
  /** Persisted 5xx rows within one window; 4xx never consume this budget. Default 300. */
  maxServerErrors?: number;
  /** Window length in ms. Default 60_000. */
  windowMs?: number;
}

export interface SuppressedRejections {
  /** Start of the (first) window in which rows were dropped, epoch ms. */
  windowStart: number;
  /** Rows dropped since the last drain. */
  suppressed: number;
}

const MAX_TRACKED_KEYS = 10_000;

export class RejectedLogRateLimiter {
  private readonly maxPerKey: number;
  private readonly maxPerStatus: number;
  private readonly maxTotal: number;
  private readonly maxServerErrors: number;
  private readonly windowMs: number;
  private windowStart = 0;
  private total = 0;
  private serverErrors = 0;
  private suppressed = 0;
  private pending?: SuppressedRejections;
  private readonly counts = new Map<string, number>();
  private readonly statusCounts = new Map<number, number>();

  constructor(options: RejectedLogRateLimitOptions = {}, private readonly now: () => number = Date.now) {
    this.maxPerKey = positiveInteger(options.maxPerKey, 20);
    this.maxPerStatus = positiveInteger(options.maxPerStatus, 300);
    this.maxTotal = positiveInteger(options.maxTotal, 1200);
    this.maxServerErrors = positiveInteger(options.maxServerErrors, 300);
    this.windowMs = positiveInteger(options.windowMs, 60_000);
  }

  /** True when this rejection may be persisted. */
  allow(statusCode: number, client: string | undefined): boolean {
    this.roll();
    if (statusCode >= 500) {
      if (this.serverErrors >= this.maxServerErrors) return this.suppress();
    } else if (this.total >= this.maxTotal) {
      return this.suppress();
    }
    const statusCount = this.statusCounts.get(statusCode) ?? 0;
    if (statusCount >= this.maxPerStatus) return this.suppress();
    const key = `${statusCode}|${client ?? ''}`;
    const count = this.counts.get(key) ?? 0;
    if (count >= this.maxPerKey) return this.suppress();
    if (count === 0 && this.counts.size >= MAX_TRACKED_KEYS) return this.suppress();
    this.counts.set(key, count + 1);
    this.statusCounts.set(statusCode, statusCount + 1);
    if (statusCode >= 500) this.serverErrors += 1;
    else this.total += 1;
    return true;
  }

  /**
   * Returns the number of rows dropped in windows that have closed since the last call, once;
   * `undefined` when nothing was dropped. Callers persist one summary row for it, outside the
   * limiter.
   */
  drainSuppressed(): SuppressedRejections | undefined {
    this.roll();
    const pending = this.pending;
    this.pending = undefined;
    return pending;
  }

  /** Rejections dropped in the current window (for diagnostics). */
  get suppressedInWindow(): number {
    return this.suppressed;
  }

  private roll(): void {
    const now = this.now();
    if (now - this.windowStart < this.windowMs) return;
    if (this.suppressed > 0) {
      this.pending = this.pending
        ? { windowStart: this.pending.windowStart, suppressed: this.pending.suppressed + this.suppressed }
        : { windowStart: this.windowStart, suppressed: this.suppressed };
    }
    this.windowStart = now;
    this.total = 0;
    this.serverErrors = 0;
    this.suppressed = 0;
    this.counts.clear();
    this.statusCounts.clear();
  }

  private suppress(): false {
    this.suppressed += 1;
    return false;
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
}

/** The access-log row that records dropped rejections; written outside the limiter. */
export function suppressedRejectionsLog(summary: SuppressedRejections) {
  return {
    action: 'http:suppressed',
    describe: `${summary.suppressed} rejected requests not persisted`,
    module: 'http',
    requestTime: new Date(summary.windowStart),
  };
}
