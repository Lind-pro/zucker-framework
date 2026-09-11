export interface ScopedCancellationRegistryOptions<TKey> {
  onReplace?: (key: TKey) => void;
  onAbort?: (key: TKey) => void;
}

/**
 * Coordinates cancellation within one process. Re-registering a key replaces
 * its signal without aborting the old one; callers own duplicate-work policy.
 * Cleanup only forgets a signal. This carries no persisted execution state.
 */
export class ScopedCancellationRegistry<TKey = string> {
  private readonly controllers = new Map<TKey, AbortController>();
  constructor(private readonly options: ScopedCancellationRegistryOptions<TKey> = {}) {}

  register(key: TKey): AbortSignal {
    if (this.controllers.has(key)) this.options.onReplace?.(key);
    const controller = new AbortController();
    this.controllers.set(key, controller);
    return controller.signal;
  }

  abort(key: TKey): boolean {
    const controller = this.controllers.get(key);
    if (!controller) return false;
    controller.abort();
    this.controllers.delete(key);
    this.options.onAbort?.(key);
    return true;
  }

  cleanup(key: TKey): void {
    this.controllers.delete(key);
  }
}
