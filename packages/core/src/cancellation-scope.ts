export interface CancellationScope {
  controller: AbortController;
  signal: AbortSignal;
  dispose(): void;
}
export interface CancellationScopeOptions {
  parent?: AbortSignal;
  timeoutMs?: number;
  /** Set false so the deadline does not keep a Node.js process alive. */
  ref?: boolean;
  abortReason?: (reason: unknown) => unknown;
  timeoutReason?: (timeoutMs: number) => unknown;
}

/** Link cancellation and an optional deadline; dispose always removes the parent listener. */
export function createCancellationScope(options: CancellationScopeOptions = {}): CancellationScope {
  const { parent, timeoutMs } = options;
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new RangeError('timeoutMs must be greater than 0');
  }
  const controller = new AbortController();
  const onAbort = () =>
    controller.abort(options.abortReason ? options.abortReason(parent?.reason) : parent?.reason);
  if (parent?.aborted) onAbort();
  else parent?.addEventListener('abort', onAbort, { once: true });
  const timer =
    timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          controller.abort(
            options.timeoutReason?.(timeoutMs) ??
              new Error(`Operation timed out after ${timeoutMs}ms`),
          );
        }, timeoutMs);
  if (options.ref === false && timer && typeof timer === 'object' && 'unref' in timer) {
    timer.unref();
  }
  return {
    controller,
    signal: controller.signal,
    dispose: () => {
      if (timer) clearTimeout(timer);
      parent?.removeEventListener('abort', onAbort);
    },
  };
}

/** Stop waiting on cancellation and consume late resolution/rejection without cancelling unrelated work. */
export function waitForSignal<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  createError: () => unknown = () => signal.reason ?? new Error('Operation aborted'),
): Promise<T> {
  if (signal.aborted) {
    void operation.catch(() => {});
    return Promise.reject(createError());
  }
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      cleanup();
      reject(createError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void operation.then(
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
