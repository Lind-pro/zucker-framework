import {
  createCancellationScope,
  waitForSignal,
  type CancellationScope,
} from '@zucker-framework/core';
import { AICallAbortedError, AICallTimeoutError } from './ai-call-errors';

export type AbortScope = CancellationScope;

export function createAbortScope(parent?: AbortSignal, timeoutMs?: number): AbortScope {
  return createCancellationScope({
    parent,
    timeoutMs,
    abortReason: (reason) => new AICallAbortedError(reason),
    timeoutReason: (timeout) => new AICallTimeoutError(timeout),
  });
}

export function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new AICallAbortedError(signal.reason);
}

export function waitForAbortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return waitForSignal(promise, signal, () => abortError(signal));
}

export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      reject(abortError(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Compose direct-provider cancellation with an optional provider timeout. */
export function providerRequestSignal(
  signal?: AbortSignal,
  timeoutMs?: number,
): AbortSignal | undefined {
  if (timeoutMs !== undefined && timeoutMs <= 0) {
    throw new RangeError('timeoutMs must be greater than 0');
  }
  if (timeoutMs === undefined) return signal;
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
