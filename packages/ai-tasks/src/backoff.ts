import type { AITaskKind } from './types';

export interface AITaskPollingOptions {
  /** Delay before the first status poll, default 2 s. */
  initialDelayMs?: number;
  /** Cap of the exponential poll delay, default 60 s. */
  maxDelayMs?: number;
  /** Growth factor per poll, default 2. */
  factor?: number;
  /** Total wait for the provider from submission; afterwards the task fails and the hold is released. */
  maxWaitMs?: Partial<Record<AITaskKind, number>>;
  /** @deprecated Ignored: waiting tasks hold no worker; each poll is a separate short run. */
  wakeCheckIntervalMs?: number;
  /** Poll runs allowed per task (durable attempt budget); default derived from maxWaitMs and the fastest poll interval. */
  maxPolls?: number;
  /** Consecutive failed status polls tolerated before the task fails, default 5. */
  maxConsecutivePollErrors?: number;
  /** An unverified callback can move the next poll forward at most once per this interval, default 10 s. */
  earlyPollMinIntervalMs?: number;
}

export const DEFAULT_MAX_WAIT_MS: Readonly<Record<AITaskKind, number>> = {
  image: 10 * 60_000,
  video: 30 * 60_000,
  audio: 20 * 60_000,
};

/** Delay before poll number `pollCount + 1`: initial * factor^pollCount, capped. */
export function pollDelayMs(pollCount: number, options: AITaskPollingOptions = {}): number {
  const initial = options.initialDelayMs ?? 2_000;
  const max = options.maxDelayMs ?? 60_000;
  const factor = options.factor ?? 2;
  const exponent = Math.max(0, Math.min(pollCount, 64));
  return Math.max(0, Math.min(max, Math.round(initial * factor ** exponent)));
}
