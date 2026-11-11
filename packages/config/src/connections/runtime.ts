import { invalidConnectionInput } from './errors';
import { assertSecretsFollowEndpoint, validateConnectionProfile, type ConnectionProfileUpdate } from './fields';
import type { ConnectionProfile, ConnectionProfileDefinition } from './registry';
import { RuntimeProviderSlot, type RuntimeProviderFreshness, type RuntimeProviderSlotOptions, type RuntimeProviderSlotSource, type RuntimeProviderState } from './slot';
import type { ArchivedConnectionRevision, ConnectionProfileStore, ConnectionSaveResult, ConnectionTransaction, StoredConnectionProfile } from './store';

/**
 * Upper bound on how long another replica may serve a superseded profile through the cache. The
 * saving process invalidates its own cache when the save commits; there is no cross-replica invalidation.
 */
export const CONNECTION_PROFILE_CACHE_TTL_MS = 30_000;

export interface ConnectionDatabase<Tx extends ConnectionTransaction = ConnectionTransaction> {
  transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T>;
}
export interface ConnectionRuntimeOptions {
  readonly database: ConnectionDatabase;
  readonly store: ConnectionProfileStore;
  /** Bootstrap environment (copied and frozen). Never return it, or anything derived from it, over HTTP. */
  readonly environment: NodeJS.ProcessEnv;
  /** Per-process cache lifetime for `liveEnvironment()` and `ttl` slots (default 30 s). */
  readonly cacheTtlMs?: number;
  /** Clock for the cache (tests). */
  readonly now?: () => number;
}
export interface ConnectionRuntimeSaveResult extends ConnectionSaveResult {
  /** Archive rows retained for the profile after the save (inside the same transaction). */
  readonly retainedRevisions: number;
}

/** Merges stored overrides: `null` removes the key (an explicit clear also hides the base value). */
export function mergeStoredConnection(environment: NodeJS.ProcessEnv, stored: StoredConnectionProfile): void {
  for (const [key, value] of Object.entries(stored.values)) {
    if (value === null) delete environment[key]; else environment[key] = value;
  }
}

/**
 * Framework-neutral runtime over a `ConnectionProfileStore`:
 * - `environment()`: the frozen start-up snapshot every `restart` provider reads (computed once per
 *   instance; a failed load never falls back to the process environment). Start-up also archives the
 *   current revision of each saved profile when its archive row is missing.
 * - `liveEnvironment()`: the snapshot with every `hot` profile replaced by its current stored value.
 * - `environmentAt(profileId, revision)`: base environment plus one archived revision (credentials an
 *   existing record was created under).
 * - `createSlot(...)`: a `RuntimeProviderSlot` over current stored values.
 * Errors are `ConnectionSettingsError` with fixed messages; adapters map `status` to their transport.
 */
export class ConnectionRuntime implements RuntimeProviderSlotSource {
  readonly base: Readonly<NodeJS.ProcessEnv>;
  private readonly applied = new Map<string, number>();
  private snapshot?: Promise<Readonly<NodeJS.ProcessEnv>>;
  private readonly ttlMs: number;
  private readonly now: () => number;
  /** Per profile: the cached stored value and a generation bumped by every local save. */
  private readonly cache = new Map<string, { expires: number; value: Promise<StoredConnectionProfile> }>();
  private readonly generation = new Map<string, number>();
  constructor(private readonly options: ConnectionRuntimeOptions) {
    this.base = Object.freeze({ ...options.environment });
    this.ttlMs = options.cacheTtlMs ?? CONNECTION_PROFILE_CACHE_TTL_MS;
    this.now = options.now ?? Date.now;
  }
  get store(): ConnectionProfileStore { return this.options.store; }
  get definitions(): readonly ConnectionProfileDefinition[] { return this.options.store.definitions; }
  private get database(): ConnectionDatabase { return this.options.database; }
  definition(profileId: string): ConnectionProfileDefinition {
    const definition = this.store.definition(profileId);
    if (!definition) throw invalidConnectionInput('Unknown connection profile');
    return definition;
  }
  /** Revision applied at start-up for one profile (0 when never saved); undefined before `environment()`. */
  appliedRevisionOf(profileId: string): number | undefined { return this.applied.get(profileId); }
  /**
   * Applied revisions of the profiles whose id starts with `prefix`, as `id@revision` pairs (for
   * example the payment configuration a new order is created with). Null before `environment()`.
   */
  appliedRevision(prefix: string): string | null {
    const entries = [...this.applied].filter(([id]) => id.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b));
    return entries.length ? entries.map(([id, revision]) => `${id}@${revision}`).join(',') : null;
  }
  /** All `restart` providers receive this one immutable start-up snapshot. */
  environment(): Promise<Readonly<NodeJS.ProcessEnv>> {
    this.snapshot ??= this.database.transaction(async tx => {
      const definitions = this.definitions;
      for (const { profile } of definitions) await this.store.lock(tx, profile.id);
      const env = { ...this.base }, revisions = new Map<string, number>(), saved: ConnectionProfileDefinition[] = [];
      for (const definition of definitions) {
        let stored = await this.store.read(tx, definition.profile);
        if (stored.revision) {
          saved.push(definition);
          // A renumbered live value (see `ensureArchived`) is read again so the applied revision matches the archive.
          if (await this.store.ensureArchived(tx, definition.profile.id, stored)) stored = await this.store.read(tx, definition.profile);
        }
        mergeStoredConnection(env, stored); revisions.set(definition.profile.id, stored.revision);
      }
      for (const definition of saved) await validateConnectionProfile(definition, env);
      for (const [id, revision] of revisions) this.applied.set(id, revision);
      return Object.freeze(env);
    });
    return this.snapshot;
  }
  /** Stored value of one profile through the per-process cache. Rejections are never cached. */
  cachedProfile(profile: ConnectionProfile): Promise<StoredConnectionProfile> {
    const cached = this.cache.get(profile.id), now = this.now();
    if (cached && cached.expires > now) return cached.value;
    const generation = this.generation.get(profile.id) ?? 0;
    const value = this.database.transaction(tx => this.store.read(tx, profile));
    this.cache.set(profile.id, { expires: now + this.ttlMs, value });
    value.catch(() => { if (this.cache.get(profile.id)?.value === value) this.cache.delete(profile.id); });
    // A save that committed while this read was in flight must not be overwritten by the older result.
    void value.then(() => { if ((this.generation.get(profile.id) ?? 0) !== generation && this.cache.get(profile.id)?.value === value) this.cache.delete(profile.id); }, () => undefined);
    return value;
  }
  /** Drops the cached value of one profile in this process (called after a local save commits). */
  invalidate(profileId: string): void {
    this.generation.set(profileId, (this.generation.get(profileId) ?? 0) + 1); this.cache.delete(profileId);
  }
  /** Start-up snapshot with the given profiles' fields reset to the base environment and replaced by `stored`. */
  private overlay(snapshot: Readonly<NodeJS.ProcessEnv>, stored: ReadonlyMap<string, StoredConnectionProfile>): NodeJS.ProcessEnv {
    const env = { ...snapshot };
    for (const [id, value] of stored) {
      for (const field of this.definition(id).profile.fields) { if (this.base[field.key] === undefined) delete env[field.key]; else env[field.key] = this.base[field.key]; }
      mergeStoredConnection(env, value);
    }
    return env;
  }
  /**
   * Current environment for `hot` consumers: the start-up snapshot with every hot profile's fields
   * replaced by its current stored value (base environment as fallback), plus the revisions read.
   * Internal only; never return the environment through HTTP.
   */
  async liveEnvironment(): Promise<{ environment: Readonly<NodeJS.ProcessEnv>; revisions: ReadonlyMap<string, number> }> {
    const snapshot = await this.environment(), stored = new Map<string, StoredConnectionProfile>();
    for (const { profile } of this.definitions.filter(row => row.applyMode === 'hot')) stored.set(profile.id, await this.cachedProfile(profile));
    return { environment: Object.freeze(this.overlay(snapshot, stored)), revisions: new Map([...stored].map(([id, value]) => [id, value.revision])) };
  }
  /**
   * Base environment plus one archived revision of one profile; `undefined` when that revision is not
   * retained. Unreadable archive rows fail closed (503). Internal only.
   */
  async environmentAt(profileId: string, revision: number): Promise<Readonly<NodeJS.ProcessEnv> | undefined> {
    this.definition(profileId); await this.environment();
    const stored = await this.database.transaction(tx => this.store.readRevision(tx, profileId, revision));
    if (!stored) return undefined;
    const env = { ...this.base }; mergeStoredConnection(env, stored);
    return Object.freeze(env);
  }
  /** Slot source: revisions now (strict: plain indexed read; ttl: cache) and a loader for the matching environment. */
  async providerState(profileIds: readonly string[], freshness: RuntimeProviderFreshness): Promise<RuntimeProviderState> {
    const definitions = profileIds.map(id => this.definition(id)), snapshot = await this.environment();
    if (freshness === 'ttl') {
      const stored = new Map<string, StoredConnectionProfile>();
      for (const { profile } of definitions) stored.set(profile.id, await this.cachedProfile(profile));
      const revisions = new Map([...stored].map(([id, value]) => [id, value.revision]));
      return { revisions, load: async () => ({ environment: Object.freeze(this.overlay(snapshot, stored)), revisions }) };
    }
    const revisions = await this.database.transaction(async tx => {
      const result = new Map<string, number>();
      for (const { profile } of definitions) result.set(profile.id, await this.store.currentRevision(tx, profile.id));
      return result;
    });
    return {
      revisions,
      load: async () => {
        const stored = await this.database.transaction(async tx => {
          const result = new Map<string, StoredConnectionProfile>();
          for (const { profile } of definitions) result.set(profile.id, await this.store.read(tx, profile));
          return result;
        });
        return { environment: Object.freeze(this.overlay(snapshot, stored)), revisions: new Map([...stored].map(([id, value]) => [id, value.revision])) };
      },
    };
  }
  createSlot<T>(options: RuntimeProviderSlotOptions<T>): RuntimeProviderSlot<T> {
    for (const id of options.profiles) this.definition(id);
    return new RuntimeProviderSlot(this, options);
  }
  /** Retained revisions of one profile, newest first (metadata only). */
  async revisions(profileId: string): Promise<ArchivedConnectionRevision[]> {
    this.definition(profileId); await this.environment();
    return this.database.transaction(tx => this.store.revisions(tx, profileId));
  }
  /** Current stored revision without decryption (0 when never saved). */
  async currentRevision(profileId: string): Promise<number> {
    this.definition(profileId); await this.environment();
    return this.database.transaction(tx => this.store.currentRevision(tx, profileId));
  }
  /**
   * Compare-and-swap save. Verifies the candidate against the base environment (endpoint/secret rule
   * and local assembly) under the profile lock, writes value, archive row and audit in one transaction,
   * then invalidates this process's cache.
   */
  async save(actorId: string, profileId: string, update: ConnectionProfileUpdate): Promise<ConnectionRuntimeSaveResult> {
    if (!actorId) throw invalidConnectionInput('Authenticated connection operator is required');
    const definition = this.definition(profileId); await this.environment();
    const result = await this.database.transaction(async tx => {
      const saved = await this.store.save(tx, definition, update, actorId, {
        verify: async (next, previous) => {
          const candidate = { ...this.base }; mergeStoredConnection(candidate, next);
          const before = { ...this.base }; mergeStoredConnection(before, previous);
          assertSecretsFollowEndpoint(definition.profile, before, candidate, update.secrets);
          await validateConnectionProfile(definition, candidate);
        },
      });
      const retainedRevisions = (await this.store.retainedCounts(tx)).get(profileId) ?? 0;
      return { ...saved, retainedRevisions };
    });
    // Invalidate only after the commit, so the next read in this process sees the new revision.
    this.invalidate(profileId);
    return result;
  }
}

