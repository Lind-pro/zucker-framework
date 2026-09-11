export interface SingleProcessTaskSupervisorOptions {
  concurrency: number;
  scanIntervalMs: number;
  /** Perform consumer-owned startup recovery and return keys that require resumption. */
  initialize?: () => Promise<readonly string[]>;
  loadPending: () => Promise<readonly string[]>;
  run: (id: string, recovery: boolean) => Promise<void>;
  abort: (id: string) => void;
  onScanError?: (error: unknown) => void;
  onExecutionError?: (id: string, error: unknown) => void | Promise<void>;
}

/**
 * One-process FIFO scheduling, deduplication and recovery polling. Persistent
 * state belongs to the consumer. This provides no lease, fencing or multi-executor safety.
 * Shutdown aborts active callbacks immediately and deliberately does not drain them.
 */
export class SingleProcessTaskSupervisor {
  private readonly queued = new Set<string>();
  private readonly running = new Map<string, Promise<void>>();
  private readonly interrupted = new Set<string>();
  private queue: string[] = [];
  private scanTimer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private started = false;
  constructor(private readonly options: SingleProcessTaskSupervisorOptions) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.started || this.stopped) return;
    this.started = true;
    const interrupted = (await this.options.initialize?.()) ?? [];
    interrupted.forEach((id) => this.interrupted.add(id));
    await this.scanPending();
    this.scheduleScan();
  }
  submit(id: string): void {
    if (this.stopped || this.queued.has(id) || this.running.has(id)) return;
    this.queued.add(id);
    this.queue.push(id);
    this.drain();
  }
  submitRecovery(id: string): void {
    if (this.stopped || this.queued.has(id) || this.running.has(id)) return;
    this.interrupted.add(id);
    this.submit(id);
  }
  async waitForIdle(): Promise<void> {
    while (this.queue.length > 0 || this.running.size > 0) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.scanTimer) clearTimeout(this.scanTimer);
    this.queue = [];
    this.queued.clear();
    this.interrupted.clear();
    for (const id of this.running.keys()) this.options.abort(id);
  }
  private drain(): void {
    while (!this.stopped && this.running.size < this.options.concurrency && this.queue.length > 0) {
      const id = this.queue.shift();
      if (id === undefined) return;
      this.queued.delete(id);
      const recovery = this.interrupted.delete(id);
      const execution = Promise.resolve()
        .then(() => this.options.run(id, recovery))
        .catch((error: unknown) => this.options.onExecutionError?.(id, error))
        .catch(() => {})
        .finally(() => {
          this.running.delete(id);
          this.drain();
        });
      this.running.set(id, execution);
    }
  }
  private async scanPending(): Promise<void> {
    if (this.stopped) return;
    const pending = await this.options.loadPending();
    pending.forEach((id) => this.submit(id));
  }
  private scheduleScan(): void {
    if (this.stopped) return;
    this.scanTimer = setTimeout(() => {
      void this.scanPending()
        .catch((error: unknown) => this.options.onScanError?.(error))
        .catch(() => {})
        .finally(() => this.scheduleScan());
    }, this.options.scanIntervalMs);
    this.scanTimer.unref?.();
  }
}
