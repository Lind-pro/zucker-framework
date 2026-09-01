/**
 * Lifecycle hook interface for reacting to registration/unregistration events.
 * @template T - The type of the managed item
 */
export interface LifecycleHook<T> {
  /** Called when an item is registered */
  onRegister?(item: T): void | Promise<void>;
  /** Called when an item is unregistered */
  onUnregister?(item: T): void | Promise<void>;
}

/**
 * Manager for lifecycle hooks — fires register/unregister events to all registered hooks.
 * @template T - The type of the managed item
 */
export class HookManager<T> {
  private hooks: LifecycleHook<T>[] = [];

  /**
   * Add a lifecycle hook.
   * @param hook - The hook to add
   */
  addHook(hook: LifecycleHook<T>): void {
    this.hooks.push(hook);
  }

  /**
   * Remove a previously added lifecycle hook.
   * @param hook - The hook to remove
   */
  removeHook(hook: LifecycleHook<T>): void {
    const idx = this.hooks.indexOf(hook);
    if (idx >= 0) this.hooks.splice(idx, 1);
  }

  /**
   * Fire the onRegister event on all hooks.
   * @param item - The item being registered
   */
  async fireRegister(item: T): Promise<void> {
    for (const hook of this.hooks) {
      await hook.onRegister?.(item);
    }
  }

  /**
   * Fire the onUnregister event on all hooks.
   * @param item - The item being unregistered
   */
  async fireUnregister(item: T): Promise<void> {
    for (const hook of this.hooks) {
      await hook.onUnregister?.(item);
    }
  }

  /**
   * Get a copy of all registered hooks.
   * @returns An array of registered lifecycle hooks
   */
  getHooks(): LifecycleHook<T>[] {
    return [...this.hooks];
  }
}
