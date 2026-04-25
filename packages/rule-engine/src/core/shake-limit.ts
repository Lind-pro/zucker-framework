/**
 * Shake-limit (debounce / throttle) support for rule branches.
 * Mirrors jetlinks ShakeLimit — prevents rapid re-triggering.
 */
export interface ShakeLimitConfig {
  /** Whether shake limiting is enabled. */
  enabled: boolean;
  /** Time window in milliseconds. */
  time: number;
  /** Maximum number of triggers allowed within the time window. */
  threshold: number;
  /** Alarm on drop — fire error event when messages are dropped. */
  alarmFirst?: boolean;
}

export interface ShakeLimitResult<T> {
  /** The element that passed the shake limit. */
  element: T;
  /** Total number of triggers within the current window. */
  times: number;
}

/**
 * Creates a shake-limit filter that suppresses rapid invocations.
 * Returns a function that decides whether to allow the current invocation.
 *
 * When alarmFirst is true, the first event that meets the threshold fires
 * immediately. When false (default), only events within the threshold pass.
 * This mirrors jetlinks ShakeLimit.transfer() semantics.
 */
export function createShakeLimit(config: ShakeLimitConfig): {
  tryAcquire: () => boolean;
  reset: () => void;
  getCurrentCount: () => number;
} {
  if (!config.enabled) {
    return { tryAcquire: () => true, reset: () => {}, getCurrentCount: () => 0 };
  }

  const safeTime = Math.max(1, config.time);
  const safeThreshold = Math.max(1, config.threshold);

  let count = 0;
  let windowStart = Date.now();
  let alarmFired = false;

  return {
    tryAcquire(): boolean {
      const now = Date.now();
      if (now - windowStart >= safeTime) {
        // new window
        windowStart = now;
        count = 1;
        alarmFired = false;
        return !config.alarmFirst; // In alarmFirst mode, first event in window doesn't fire until threshold
      }
      count++;

      if (config.alarmFirst) {
        // alarmFirst: fire only when threshold is first reached
        if (count >= safeThreshold && !alarmFired) {
          alarmFired = true;
          return true;
        }
        return false;
      }

      // Default: allow events within threshold
      return count <= safeThreshold;
    },
    reset(): void {
      count = 0;
      windowStart = Date.now();
      alarmFired = false;
    },
    getCurrentCount(): number {
      return count;
    },
  };
}
