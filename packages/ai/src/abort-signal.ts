import { AICallAbortedError, AICallTimeoutError } from './ai-call-errors';

export interface AbortScope {
  signal: AbortSignal;
  dispose(): void;
}

export function createAbortScope(parent?: AbortSignal, timeoutMs?: number): AbortScope {
  if (timeoutMs !== undefined && timeoutMs <= 0) {
    throw new RangeError('timeoutMs must be greater than 0');
  }

  const controller = new AbortController();
  const abortFromParent = () => controller.abort(new AICallAbortedError(parent?.reason));
  if (parent?.aborted) abortFromParent();
  else parent?.addEventListener('abort', abortFromParent, { once: true });

  const timeout =
    timeoutMs === undefined
      ? undefined
      : setTimeout(() => controller.abort(new AICallTimeoutError(timeoutMs)), timeoutMs);

  return {
    signal: controller.signal,
    dispose: () => {
      if (timeout) clearTimeout(timeout);
      parent?.removeEventListener('abort', abortFromParent);
    },
  };
}

export function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new AICallAbortedError(signal.reason);
}

export function waitForAbortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal));

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(abortError(signal));
    };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
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
