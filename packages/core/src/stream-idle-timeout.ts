export class StreamIdleTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StreamIdleTimeoutError';
  }
}

export interface StreamIdleTimeoutOptions {
  onIdle?: () => void;
  createError?: (idleMs: number) => Error;
}

/** Bound each pending next() and close an abandoned iterator without waiting on a dead producer. */
export async function* withStreamIdleTimeout<T>(
  source: AsyncIterable<T>,
  idleMs: number,
  options: StreamIdleTimeoutOptions = {},
): AsyncGenerator<T> {
  const iterator = source[Symbol.asyncIterator]();
  try {
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const idle = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          // Settle the timeout even if an abort callback throws.
          const error =
            options.createError?.(idleMs) ??
            new StreamIdleTimeoutError(`Stream idle for ${idleMs}ms`);
          reject(error);
          try {
            options.onIdle?.();
          } catch {
            /* the timeout remains the failure */
          }
        }, idleMs);
        timer.unref?.();
      });
      let result: IteratorResult<T>;
      try {
        result = await Promise.race([iterator.next(), idle]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (result.done) return;
      yield result.value;
    }
  } finally {
    // Schedule return so a synchronous throw is handled too; never hang on cleanup.
    void Promise.resolve()
      .then(() => iterator.return?.())
      .catch(() => {});
  }
}
