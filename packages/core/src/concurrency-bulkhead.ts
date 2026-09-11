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
    private readonly maxConcurrency: number,
    private readonly maxQueueSize: number,
    private readonly queueTimeoutMs: number,
    private readonly createUnavailableError: () => Error = () =>
      new Error('Concurrency capacity exhausted'),
  ) {}

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private acquire(): Promise<() => void> {
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
