interface BulkheadWaiter {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

/** Shared bounded FIFO admission with queue timeout and idempotent slot release. */
export class ConcurrencyBulkhead {
  private active = 0;
  private readonly waiters: BulkheadWaiter[] = [];

  constructor(
    private maxConcurrency: number,
    private readonly maxQueueSize: number,
    private readonly queueTimeoutMs: number,
    private readonly createUnavailableError: () => Error = () =>
      new Error('Concurrency capacity exhausted'),
  ) {
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 ||
        !Number.isInteger(maxQueueSize) || maxQueueSize < 0 ||
        !Number.isFinite(queueTimeoutMs) || queueTimeoutMs < 0) {
      throw new RangeError('Invalid concurrency bulkhead limits');
    }
  }

  /** Change admission capacity without revoking active leases; FIFO waiters retain priority. */
  setConcurrency(limit: number): void {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError('Invalid concurrency limit');
    this.maxConcurrency = limit;
    while (this.active < limit && this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      if (waiter.timer) clearTimeout(waiter.timer);
      this.active += 1;
      waiter.resolve(this.createRelease());
    }
  }

  /** Immediate admission for Observable/subscription lifecycles; release is idempotent. */
  tryAcquire(): (() => void) | undefined {
    if (this.active >= this.maxConcurrency || this.waiters.length > 0) return undefined;
    this.active += 1;
    return this.createRelease();
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await operation();
    } finally {
      release();
    }
  }

  /** FIFO queued admission. The caller must release the returned lease in finally/teardown. */
  acquire(): Promise<() => void> {
    if (this.active < this.maxConcurrency) {
      this.active += 1;
      return Promise.resolve(this.createRelease());
    }

    if (this.waiters.length >= this.maxQueueSize) {
      return Promise.reject(this.createUnavailableError());
    }

    return new Promise((resolve, reject) => {
      const waiter: BulkheadWaiter = { resolve, reject };
      waiter.timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index === -1) {
          return;
        }

        this.waiters.splice(index, 1);
        reject(this.createUnavailableError());
      }, this.queueTimeoutMs);
      this.waiters.push(waiter);
    });
  }

  private createRelease(): () => void {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;

      // A reduced limit does not revoke leases or hand a released slot to a waiter too early.
      if (this.active > this.maxConcurrency) {
        this.active -= 1;
        return;
      }
      const waiter = this.waiters.shift();
      if (!waiter) {
        this.active -= 1;
        return;
      }

      if (waiter.timer) {
        clearTimeout(waiter.timer);
      }
      waiter.resolve(this.createRelease());
    };
  }
}
