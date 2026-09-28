export interface PoolContext { close(): Promise<void> }
export interface PoolBrowser<C extends PoolContext, O> {
  isConnected(): boolean;
  newContext(options: O): Promise<C>;
  close(): Promise<void>;
  on(event: 'disconnected', listener: () => void): unknown;
}

/** One launch per generation; independent contexts, no process-global singleton or launch policy. */
export class BrowserPool<C extends PoolContext, O> {
  private browser?: PoolBrowser<C, O>;
  private launching?: Promise<PoolBrowser<C, O>>;
  private readonly contexts = new Map<string, C>();
  private readonly creating = new Map<string, Promise<C>>();
  private readonly closing = new Map<string, Promise<void>>();
  private stopped = false;
  private shutdownPromise?: Promise<void>;

  constructor(private readonly launch: () => Promise<PoolBrowser<C, O>>) {}

  async getBrowser(): Promise<PoolBrowser<C, O>> {
    if (this.stopped) throw new Error('Browser pool is shutting down');
    if (this.browser?.isConnected()) return this.browser;
    if (!this.launching) {
      const pending = Promise.resolve().then(this.launch).then((browser) => {
        this.browser = browser;
        browser.on('disconnected', () => {
          if (this.browser === browser) {
            this.browser = undefined;
            this.contexts.clear();
          }
        });
        return browser;
      });
      this.launching = pending;
      // Clear failures as well as successes: a failed launch must not poison the pool.
      void pending.finally(() => {
        if (this.launching === pending) this.launching = undefined;
      }).catch(() => undefined);
    }
    return this.launching;
  }

  createContext(taskId: string, options: O): Promise<C> {
    if (this.stopped) return Promise.reject(new Error('Browser pool is shutting down'));
    if (this.contexts.has(taskId) || this.creating.has(taskId) || this.closing.has(taskId)) {
      return Promise.reject(new Error('Context identifier already in use'));
    }
    const pending = (async () => {
      const browser = await this.getBrowser();
      const context = await browser.newContext(options);
      if (!browser.isConnected()) {
        await context.close();
        throw new Error('Browser disconnected during context creation');
      }
      this.contexts.set(taskId, context);
      return context;
    })();
    this.creating.set(taskId, pending);
    void pending.finally(() => this.creating.delete(taskId)).catch(() => undefined);
    return pending;
  }

  closeContext(taskId: string): Promise<void> {
    const existing = this.closing.get(taskId);
    if (existing) return existing;
    const pending = (async () => {
      await this.creating.get(taskId);
      const context = this.contexts.get(taskId);
      try { await context?.close(); }
      finally { this.contexts.delete(taskId); }
    })();
    this.closing.set(taskId, pending);
    void pending.finally(() => this.closing.delete(taskId)).catch(() => undefined);
    return pending;
  }

  getActiveContextCount(): number { return this.contexts.size; }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.stopped = true;
    this.shutdownPromise = (async () => {
      // Drain creation before enumerating contexts; otherwise late contexts leak.
      await Promise.allSettled([...this.creating.values(), ...(this.launching ? [this.launching] : [])]);
      const results = await Promise.allSettled([
        ...this.closing.values(),
        ...[...this.contexts.keys()].filter((id) => !this.closing.has(id)).map((id) => this.closeContext(id)),
      ]);
      const errors = results.flatMap((r) => r.status === 'rejected' ? [r.reason] : []);
      try { await this.browser?.close(); } catch (error) { errors.push(error); }
      finally { this.browser = undefined; this.contexts.clear(); }
      if (errors.length) throw new AggregateError(errors, 'Browser pool shutdown failed');
    })();
    return this.shutdownPromise;
  }
}
