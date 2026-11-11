import { ConnectionSettingsError } from './errors';

export type RuntimeProviderFreshness = 'ttl' | 'strict';
export interface RuntimeProviderSnapshot {
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly revisions: ReadonlyMap<string, number>;
}
/** What a slot asks its source: the current revisions, and a loader for the matching environment. */
export interface RuntimeProviderState {
  readonly revisions: ReadonlyMap<string, number>;
  load(): Promise<RuntimeProviderSnapshot>;
}
export interface RuntimeProviderSlotSource {
  providerState(profileIds: readonly string[], freshness: RuntimeProviderFreshness): Promise<RuntimeProviderState>;
}
export interface RuntimeProviderSlotOptions<T> {
  /** Profile ids whose stored revisions this instance is built from. */
  readonly profiles: readonly string[];
  /**
   * Builds the instance from the environment (start-up snapshot with these profiles' fields replaced
   * by their stored values) and the revisions it reflects. Must be local: no network request.
   */
  readonly build: (environment: Readonly<NodeJS.ProcessEnv>, revisions: ReadonlyMap<string, number>) => T | Promise<T>;
  /** Releases a replaced instance once no `use()` call holds it any more. Errors go to `onBuildError`, never thrown. */
  readonly dispose?: (instance: T) => void | Promise<void>;
  /**
   * `strict`: every `get()`/`use()` reads the current revisions (one indexed read per profile, no
   * decryption), so a superseded revision is never used once a save has committed (any replica).
   * `ttl`: uses the per-process profile cache (bounded staleness on other replicas, immediate locally).
   */
  readonly freshness: RuntimeProviderFreshness;
  /**
   * Called once per failing revision set. Receives the error so the caller may log its class; callers
   * must not log `error.message` verbatim, since provider builders may echo configuration.
   */
  readonly onBuildError?: (error: unknown, revisions: ReadonlyMap<string, number>) => void;
}
export interface RuntimeProviderSlotState {
  /** Revisions of the instance currently served, or undefined before the first successful build. */
  readonly revisions?: ReadonlyMap<string, number>;
  /** Revisions of the newest failed build (the previous instance keeps serving), if any. */
  readonly failedRevisions?: ReadonlyMap<string, number>;
}

interface Entry<T> { instance: T; signature: string; revisions: ReadonlyMap<string, number>; leases: number; retired: boolean; disposed: boolean }

function signatureOf(profiles: readonly string[], revisions: ReadonlyMap<string, number>): string {
  return profiles.map(id => `${id}@${revisions.get(id) ?? 0}`).join(',');
}
/** True when every revision of `candidate` is at least the one in `current`. */
function notOlder(profiles: readonly string[], candidate: ReadonlyMap<string, number>, current: ReadonlyMap<string, number>): boolean {
  return profiles.every(id => (candidate.get(id) ?? 0) >= (current.get(id) ?? 0));
}

export const SLOT_BUILD_FAILED = 'Connection provider could not be assembled from the current configuration';

/**
 * Holds one provider instance per set of stored revisions. When the revisions change, the next caller
 * builds a replacement (concurrent callers share one build) and swaps it in atomically. A failed
 * build keeps serving the previous instance and is reported once; with no previous instance the
 * call fails with a generic 503 `ConnectionSettingsError`. A replaced instance is disposed after the
 * last `use()` holding it returns.
 *
 * Use `use(fn)` for any work that spans an `await` (sends, streams, uploads): the instance is leased
 * for the duration of `fn` and is never disposed underneath it. `get()` returns the current instance
 * without a lease; use it only for synchronous reads.
 */
export class RuntimeProviderSlot<T> {
  private current?: Entry<T>;
  private pending?: { signature: string; promise: Promise<Entry<T>> };
  private failed?: { signature: string; loaded: string; revisions: ReadonlyMap<string, number> };
  private closed = false;
  private readonly profiles: readonly string[];
  constructor(private readonly source: RuntimeProviderSlotSource, private readonly options: RuntimeProviderSlotOptions<T>) {
    if (!options.profiles.length || new Set(options.profiles).size !== options.profiles.length) throw new Error('A provider slot needs distinct profile ids');
    if (options.freshness !== 'ttl' && options.freshness !== 'strict') throw new Error("A provider slot needs freshness 'ttl' or 'strict'");
    this.profiles = Object.freeze([...options.profiles]);
  }
  /** Current instance without a lease (see class comment). */
  async get(): Promise<T> {
    const entry = await this.acquire(false);
    return entry.instance;
  }
  /** Runs `fn` with the current instance leased; the instance is not disposed before `fn` settles. */
  async use<R>(fn: (instance: T, revisions: ReadonlyMap<string, number>) => R | Promise<R>): Promise<R> {
    const entry = await this.acquire(true);
    try { return await fn(entry.instance, entry.revisions); }
    finally { entry.leases -= 1; this.disposeIfIdle(entry); }
  }
  state(): RuntimeProviderSlotState {
    return { revisions: this.current?.revisions, failedRevisions: this.failed?.revisions };
  }
  /** Retires the current instance (disposed when idle). Later calls fail. */
  async close(): Promise<void> {
    this.closed = true;
    const entry = this.current; this.current = undefined;
    if (entry) { entry.retired = true; await this.disposeIfIdle(entry); }
  }
  private lease(entry: Entry<T>, leased: boolean): Entry<T> {
    // Synchronous with the decision to serve `entry`, so no swap can dispose it in between.
    if (leased) entry.leases += 1;
    return entry;
  }
  private async acquire(leased: boolean): Promise<Entry<T>> {
    if (this.closed) throw new Error('Provider slot is closed');
    const state = await this.source.providerState(this.profiles, this.options.freshness);
    const signature = signatureOf(this.profiles, state.revisions);
    if (this.current && this.current.signature === signature) return this.lease(this.current, leased);
    if (this.failed && (this.failed.signature === signature || this.failed.loaded === signature)) return this.fallback(leased);
    if (this.current && !notOlder(this.profiles, state.revisions, this.current.revisions)) return this.lease(this.current, leased);
    const pending = this.pending?.signature === signature ? this.pending.promise : this.startBuild(signature, state);
    let built: Entry<T>;
    try { built = await pending; } catch { return this.fallback(leased); }
    if (this.closed) throw new Error('Provider slot is closed');
    if (this.current !== built && this.current && notOlder(this.profiles, this.current.revisions, built.revisions)) return this.lease(this.current, leased);
    return this.lease(built, leased);
  }
  private fallback(leased: boolean): Entry<T> {
    if (this.current) return this.lease(this.current, leased);
    throw new ConnectionSettingsError(503, SLOT_BUILD_FAILED);
  }
  private startBuild(requested: string, state: { load(): Promise<RuntimeProviderSnapshot> }): Promise<Entry<T>> {
    const promise = (async () => {
      const snapshot = await state.load();
      const signature = signatureOf(this.profiles, snapshot.revisions);
      if (this.current?.signature === signature) return this.current;
      let instance: T;
      try { instance = await this.options.build(snapshot.environment, snapshot.revisions); }
      catch (error) {
        // Report once per loaded revision set; remember the requested set too, so callers that still
        // see it fall back without rebuilding (requested and loaded differ when a save lands in between).
        const first = this.failed?.loaded !== signature;
        this.failed = { signature: requested, loaded: signature, revisions: snapshot.revisions };
        if (first) { try { this.options.onBuildError?.(error, snapshot.revisions); } catch { /* reporting must not mask the fallback */ } }
        throw error;
      }
      const entry: Entry<T> = { instance, signature, revisions: snapshot.revisions, leases: 0, retired: false, disposed: false };
      if (this.closed || this.current && !notOlder(this.profiles, entry.revisions, this.current.revisions)) {
        // A newer instance was swapped in while this one was building (or the slot closed): discard it.
        entry.retired = true; void this.disposeIfIdle(entry);
        return this.closed || !this.current ? entry : this.current;
      }
      const previous = this.current;
      this.current = entry;
      if (this.failed && notOlder(this.profiles, entry.revisions, this.failed.revisions)) this.failed = undefined;
      if (previous && previous !== entry) { previous.retired = true; void this.disposeIfIdle(previous); }
      return entry;
    })();
    this.pending = { signature: requested, promise };
    const clear = () => { if (this.pending?.promise === promise) this.pending = undefined; };
    promise.then(clear, clear);
    return promise;
  }
  private async disposeIfIdle(entry: Entry<T>): Promise<void> {
    if (!entry.retired || entry.leases > 0 || entry.disposed) return;
    entry.disposed = true;
    try { await this.options.dispose?.(entry.instance); }
    catch (error) { try { this.options.onBuildError?.(error, entry.revisions); } catch { /* ignore */ } }
  }
}
