import { AsyncLocalStorage } from 'node:async_hooks';
import { Logger, ServiceUnavailableException } from '@nestjs/common';
import {
  RuntimeProviderSlot, type RuntimeProviderSlotOptions, type RuntimeProviderSlotSource, type RuntimeProviderSlotState,
} from '@zucker-framework/config/connections';

/** The part of `ConnectionSettingsService` a hot provider needs (a slot over current stored values). */
export interface HotProviderSettings {
  createSlot<T>(options: RuntimeProviderSlotOptions<T>): RuntimeProviderSlot<T>;
}

/**
 * Hot-applied connection providers (`applyMode: 'hot'`).
 *
 * A `HotProvider` wraps one `RuntimeProviderSlot` (from `@zucker-framework/config/connections`) and adds
 * what the template's consumers need:
 * - `use(fn)`: asynchronous work (a send, an upload, a code exchange) leases the instance it started
 *   with; a replaced instance is disposed only after the last lease ends.
 * - `middleware()`: pins one instance for a whole HTTP request (and leases it until the response
 *   closes), so synchronous readers inside the request (`now()`, the `live*` views below) see one
 *   consistent revision even if a save commits while the request runs.
 * - `now()`: the pinned instance, else the newest resolved one. Outside a pinned request (job workers)
 *   every read also schedules a background refresh, so a change is seen from the next read on.
 * A failed build keeps the previous instance serving and is reported once (revisions only; the error
 * message is never logged because provider builders may echo configuration). Management reads the
 * served and failed revisions through `hotConnectionStatus`.
 *
 * Without `ConnectionSettingsService` (unit tests, tools that build one module) the provider is built
 * once from the supplied environment (or `process.env` when none is given) and never changes.
 */
export interface HotProviderOptions<T> extends Omit<RuntimeProviderSlotOptions<T>, 'freshness' | 'onBuildError'> {
  /** Short provider name for logs (no configuration values). */
  readonly name: string;
}
interface HotRegistration { readonly profiles: readonly string[]; state(): RuntimeProviderSlotState }

const registrations = new WeakMap<object, Set<HotRegistration>>();
const logger = new Logger('HotConnections');

/** A slot source that always serves one fixed environment at revision 0 (no runtime settings available). */
function fixedSource(environment: Readonly<NodeJS.ProcessEnv>): RuntimeProviderSlotSource {
  const frozen = Object.freeze({ ...environment });
  return {
    async providerState(profileIds) {
      const revisions = new Map(profileIds.map(id => [id, 0]));
      return { revisions, load: async () => ({ environment: frozen, revisions }) };
    },
  };
}
const signature = (revisions: ReadonlyMap<string, number>) => [...revisions].map(([id, revision]) => `${id}@${revision}`).join(',');

export class HotProvider<T> {
  readonly slot: RuntimeProviderSlot<T>;
  private latest?: T;
  private refreshing?: Promise<unknown>;
  private readonly pinned = new AsyncLocalStorage<T>();
  /** Set by `fixed()`: the value served from the start, disposed on close if the slot never built it. */
  private initial?: { value: T };
  private disposeOnce?: (instance: T) => Promise<void>;
  private closing = false;
  private unregister?: () => void;
  private closeError?: { error: unknown };
  private constructor(slot: (onBuildError: RuntimeProviderSlotOptions<T>['onBuildError']) => RuntimeProviderSlot<T>, readonly name: string) {
    this.slot = slot((error, revisions) =>
      logger.warn(`${name}: building or closing the provider for ${signature(revisions)} failed (${error instanceof Error ? error.name : 'error'}); a failed build keeps the previous configuration serving`));
  }
  /**
   * Over the current stored values of `options.profiles` when `settings` is available (`ttl`
   * freshness: the saving process sees the change on its next read, other replicas within the
   * profile cache TTL); otherwise over the fixed `environment` (or `process.env`).
   */
  static create<T>(settings: HotProviderSettings | undefined, environment: Readonly<NodeJS.ProcessEnv> | undefined, options: HotProviderOptions<T>): HotProvider<T> {
    const { name, dispose, ...rest } = options;
    // Each instance is disposed at most once (a fixed value can reach disposal through the slot and
    // through `close()`); a failure while closing is rethrown by `close()`, otherwise it is only logged.
    const disposed = new WeakSet<object>();
    const disposeOnce = dispose && (async (instance: T) => {
      if (typeof instance === 'object' && instance !== null) { if (disposed.has(instance)) return; disposed.add(instance); }
      try { await dispose(instance); } catch (error) { if (provider.closing) provider.closeError ??= { error }; throw error; }
    });
    const slotOptions = { ...rest, ...(disposeOnce ? { dispose: disposeOnce } : {}) };
    const provider: HotProvider<T> = new HotProvider<T>(onBuildError => settings
      ? settings.createSlot({ ...slotOptions, freshness: 'ttl', onBuildError })
      // Compatibility fallback for tools/tests that build one provider module without settings or an environment.
      // eslint-disable-next-line no-restricted-syntax
      : new RuntimeProviderSlot(fixedSource(environment ?? process.env), { ...slotOptions, freshness: 'ttl', onBuildError }), name);
    provider.disposeOnce = disposeOnce;
    if (settings) {
      const set = registrations.get(settings) ?? new Set<HotRegistration>();
      const registration = { profiles: Object.freeze([...options.profiles]), state: () => provider.slot.state() };
      set.add(registration); registrations.set(settings, set);
      provider.unregister = () => set.delete(registration);
    }
    return provider;
  }
  /** A provider that always serves `value` (readable synchronously at once). */
  static fixed<T>(value: T, options: { name: string; profiles: readonly string[]; dispose?: (instance: T) => void | Promise<void> }): HotProvider<T> {
    const provider = HotProvider.create<T>(undefined, {}, { ...options, build: () => value });
    provider.latest = value; provider.initial = { value };
    return provider;
  }
  /** The current instance (pinned in a request, else resolved now). Use `use()` for work that spans an `await`. */
  async current(): Promise<T> {
    const pinned = this.pinned.getStore();
    if (pinned !== undefined) return pinned;
    const instance = await this.slot.get();
    this.latest = instance;
    return instance;
  }
  /** Resolves the current instance once (start-up), so synchronous readers have a value. */
  async ready(): Promise<this> { await this.current(); return this; }
  /**
   * Synchronous read: the request-pinned instance, else the newest resolved one (a background refresh
   * is scheduled, so a save is visible from the next read on). Throws before `ready()`.
   */
  now(): T {
    const pinned = this.pinned.getStore();
    if (pinned !== undefined) return pinned;
    this.refreshing ??= this.slot.get().then(instance => { this.latest = instance; }, () => undefined).finally(() => { this.refreshing = undefined; });
    if (this.latest === undefined) throw new ServiceUnavailableException('Connection provider is not ready');
    return this.latest;
  }
  /** Runs `fn` with one instance leased (and pinned for synchronous readers inside `fn`). */
  use<R>(fn: (instance: T) => R | Promise<R>): Promise<R> {
    const pinned = this.pinned.getStore();
    if (pinned !== undefined) return Promise.resolve().then(() => fn(pinned));
    return this.slot.use(instance => { this.latest = instance; return this.pinned.run(instance, () => fn(instance)); });
  }
  /**
   * Express middleware: pins and leases one instance for the request until the response closes
   * (streams included). With no instance at all (the very first build failed) the request gets 503.
   */
  middleware() {
    return (_request: unknown, response: { once(event: 'close', listener: () => void): unknown }, next: (error?: unknown) => void): void => {
      if (this.pinned.getStore() !== undefined) { next(); return; }
      let started = false;
      this.slot.use(instance => new Promise<void>(resolve => {
        started = true; this.latest = instance;
        response.once('close', resolve);
        this.pinned.run(instance, () => next());
      })).catch(() => { if (!started) next(new ServiceUnavailableException('Connection provider is unavailable')); });
    };
  }
  state(): RuntimeProviderSlotState { return this.slot.state(); }
  /** Retires the current instance (disposed now, or when its last lease ends). Rethrows a disposal failure seen during close. */
  async close(): Promise<void> {
    const built = this.slot.state().revisions !== undefined;
    this.closing = true; this.unregister?.();
    await this.slot.close();
    if (!built && this.initial) {
      const { value } = this.initial; this.initial = undefined;
      // Never built through the slot (or still building): dispose the fixed value here, once.
      await this.disposeOnce?.(value).catch(error => { this.closeError ??= { error }; });
    }
    if (this.closeError) { const { error } = this.closeError; this.closeError = undefined; throw error; }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- owners of any instance type
const viewOwners = new WeakMap<object, HotProvider<any>>();
/** The hot provider behind a view made with `liveObjectView(..., provider)`, if any. */
export function hotProviderOf<T>(value: unknown): HotProvider<T> | undefined {
  return value && typeof value === 'object' ? viewOwners.get(value) as HotProvider<T> | undefined : undefined;
}
/**
 * Read-only object view whose properties always come from `source()` (a hot provider's `now()`), for
 * consumers that were written against a plain settings object or environment snapshot. `owner`
 * (optional) lets a consumer that needs leases find the provider again with `hotProviderOf`.
 */
export function liveObjectView<T extends object>(source: () => T, owner?: HotProvider<T>): T {
  const view = new Proxy({} as T, {
    get: (_target, property) => Reflect.get(source(), property),
    has: (_target, property) => Reflect.has(source(), property),
    ownKeys: () => Reflect.ownKeys(source()),
    getOwnPropertyDescriptor: (_target, property) => {
      const current = source();
      if (!Object.prototype.hasOwnProperty.call(current, property)) return undefined;
      return { value: Reflect.get(current, property), writable: false, enumerable: true, configurable: true };
    },
    set: () => false, defineProperty: () => false, deleteProperty: () => false,
  });
  if (owner) viewOwners.set(view, owner);
  return view;
}
/**
 * Read-only array view over `source()`. Array methods run on a frozen copy of the current array, so
 * readers (map, filter, find, iteration) work while mutators (push, splice, sort) throw instead of
 * changing the provider's own instance.
 */
export function liveArrayView<T>(source: () => readonly T[]): readonly T[] {
  return new Proxy([] as T[], {
    get: (_target, property) => {
      const current = source(), value = Reflect.get(current, property);
      return typeof value === 'function' ? value.bind(Object.isFrozen(current) ? current : Object.freeze([...current])) : value;
    },
    has: (_target, property) => Reflect.has(source(), property),
    set: () => false, defineProperty: () => false, deleteProperty: () => false,
  });
}

export interface HotConnectionStatus {
  /** Lowest revision any live provider of the profile serves (undefined until one was built). */
  readonly servedRevision?: number;
  /** Newest revision whose provider could not be assembled while an older one keeps serving. */
  readonly failedRevision?: number;
}
/** Served and failed revisions per profile id, over every hot provider created with `settings`. */
export function hotConnectionStatus(settings: HotProviderSettings): Map<string, HotConnectionStatus> {
  const result = new Map<string, { servedRevision?: number; failedRevision?: number }>();
  for (const registration of registrations.get(settings) ?? []) {
    const state = registration.state();
    for (const id of registration.profiles) {
      const row = result.get(id) ?? {};
      const served = state.revisions?.get(id), failed = state.failedRevisions?.get(id);
      if (served !== undefined) row.servedRevision = row.servedRevision === undefined ? served : Math.min(row.servedRevision, served);
      if (failed !== undefined && failed > (served ?? -1)) row.failedRevision = Math.max(row.failedRevision ?? 0, failed);
      result.set(id, row);
    }
  }
  return result;
}
