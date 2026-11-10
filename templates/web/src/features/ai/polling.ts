/**
 * Pure task-polling helpers (no React, no app imports) so node tests can load them directly.
 * The server's own wake/poll machinery decides when a provider is asked; the browser only reads
 * the task view, slower the longer nothing changes.
 */

export const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);

export function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

export interface BackoffOptions {
  /** First delay (default 1500 ms). */
  initialMs?: number;
  /** Upper bound for any delay (default 15000 ms). */
  maxMs?: number;
  /** Growth per attempt (default 1.6). */
  factor?: number;
  /** Relative jitter, 0..1 (default 0.2): spreads many open tabs instead of polling in lockstep. */
  jitter?: number;
}

/** Delay before poll number `attempt` (0-based), within [initialMs/2, maxMs]. */
export function pollDelay(attempt: number, options: BackoffOptions = {}, random: () => number = Math.random): number {
  const initialMs = Math.max(1, options.initialMs ?? 1500);
  const maxMs = Math.max(initialMs, options.maxMs ?? 15_000);
  const factor = Math.max(1, options.factor ?? 1.6);
  const jitter = Math.min(1, Math.max(0, options.jitter ?? 0.2));
  const step = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
  const base = Math.min(maxMs, initialMs * factor ** Math.min(step, 64));
  const spread = base * jitter * (random() * 2 - 1);
  return Math.round(Math.min(maxMs, Math.max(initialMs / 2, base + spread)));
}

export function abortError(signal?: AbortSignal): unknown {
  return signal?.reason ?? new DOMException('Aborted', 'AbortError');
}

/** setTimeout as a promise that rejects as soon as `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export interface PollOptions<T> {
  load: (signal?: AbortSignal) => Promise<T>;
  /** True when no further poll is needed (terminal state). */
  isDone: (value: T) => boolean;
  /** Called with every successfully loaded value, including the final one. */
  onUpdate?: (value: T) => void;
  /** A change of this key (e.g. status + progress) restarts the backoff at its first step. */
  activityKey?: (value: T) => string;
  signal?: AbortSignal;
  backoff?: BackoffOptions;
  /** Consecutive load failures tolerated before the last error is thrown (default 5). */
  maxConsecutiveErrors?: number;
  /** Errors for which retrying is pointless (e.g. 404): thrown at once. */
  isFatal?: (error: unknown) => boolean;
  /** Wait one first delay before the first load (the caller already holds a fresh value). */
  delayFirst?: boolean;
  /** Test seams. */
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
}

/**
 * Loads until `isDone`, waiting `pollDelay(attempt)` between loads. Resolves with the final value;
 * rejects with the abort reason when `signal` aborts, or with the last error after too many failures.
 */
export async function pollUntilDone<T>(options: PollOptions<T>): Promise<T> {
  const wait = options.wait ?? sleep;
  const maxErrors = Math.max(1, options.maxConsecutiveErrors ?? 5);
  let attempt = 0;
  let errors = 0;
  let lastKey: string | undefined;
  if (options.delayFirst) await wait(pollDelay(0, options.backoff, options.random), options.signal);
  for (;;) {
    if (options.signal?.aborted) throw abortError(options.signal);
    try {
      const value = await options.load(options.signal);
      if (options.signal?.aborted) throw abortError(options.signal);
      errors = 0;
      options.onUpdate?.(value);
      if (options.isDone(value)) return value;
      const key = options.activityKey?.(value);
      if (key !== undefined && lastKey !== undefined && key !== lastKey) attempt = 0;
      lastKey = key;
    } catch (error) {
      if (options.signal?.aborted) throw abortError(options.signal);
      if (options.isFatal?.(error)) throw error;
      errors += 1;
      if (errors >= maxErrors) throw error;
    }
    await wait(pollDelay(attempt, options.backoff, options.random), options.signal);
    attempt += 1;
  }
}
