import { BadRequestException, Logger, ServiceUnavailableException } from '@nestjs/common';
import {
  assertSecretsFollowEndpoint as assertSecretsFollowEndpointRule, composeConnectionProfiles, connectionStorageUnavailable,
  ConnectionRuntime, invalidConnectionInput, parseConnectionUpdate,
  type ArchivedConnectionRevision, type ConnectionApplyMode, type ConnectionDatabase, type ConnectionField, type ConnectionProfile,
  type ConnectionProfileDefinition, type ConnectionProfileStore, type ConnectionProfileUpdate, type ConnectionTransaction,
  type RuntimeProviderSlot, type RuntimeProviderSlotOptions, type SecretAction, type StoredConnectionProfile,
} from '@zucker-framework/config/connections';
import { SecretCipher } from '@zucker-framework/core';
import { AsyncLocalStorage } from 'node:async_hooks';
import { resolveModelNames, type ModelNames } from '../shared/models';
import { toHttpError, withHttpErrors, withHttpErrorsAsync } from './connection-errors';
import { PinnedConnectionProfileStore, resolveConnectionPins, type ConnectionEnvironmentPins, type ResolvedConnectionPins } from './connection-pins';

export const CONNECTION_SETTINGS_SCOPE = 'runtime.connections';
/**
 * Upper bound on how long another replica may serve a superseded `hot` profile. The saving process
 * invalidates its own cache when the save commits; there is no cross-replica invalidation.
 */
export const HOT_PROFILE_CACHE_TTL_MS = 30_000;

/** Models written through `DatabaseAdapter.model()` (audit row of every save). */
export const DEFAULT_SETTINGS_MODELS = { operationLogs: 'operationLogs' } as const;
export type SettingsModelKey = keyof typeof DEFAULT_SETTINGS_MODELS;
/** Tables addressed by fixed SQL (advisory-lock revision reads and the encrypted revision archive). Always double-quoted. */
export const DEFAULT_SETTINGS_TABLES = { config: 'config', connectionRevisions: 'connection_profile_revisions' } as const;
export type SettingsTableKey = keyof typeof DEFAULT_SETTINGS_TABLES;

/** Stable translation keys sent next to the display text, so clients translate by key, not by wording. */
export interface ConnectionLabelKeys {
  readonly labelKey: string;
  readonly categoryKey: string;
  field(field: ConnectionField): { labelKey: string; descriptionKey?: string };
}
export type ConnectionLabelKeyResolver = (profile: ConnectionProfile) => ConnectionLabelKeys;
/** `connections.<id>`, `connections.category.<category, lower-case>`, `connections.field.<KEY>[.description]`. */
export function defaultConnectionLabelKeys(profile: ConnectionProfile): ConnectionLabelKeys {
  return {
    labelKey: `connections.${profile.id}`,
    categoryKey: `connections.category.${profile.category.toLowerCase()}`,
    field: field => ({ labelKey: `connections.field.${field.key}`, ...(field.description ? { descriptionKey: `connections.field.${field.key}.description` } : {}) }),
  };
}

/** Projection of the applied public (hot) profiles for `GET <publicPath>/integrations`. Must contain public identifiers only. */
export type PublicIntegrationsProjection = (environment: Readonly<NodeJS.ProcessEnv>, revisions: ReadonlyMap<string, number>) => unknown;

export interface ConnectionSettingsServiceOptions {
  /** Composed profile definitions (`composeConnectionProfiles(...)`); the order is the admin display order. */
  readonly profiles: readonly ConnectionProfileDefinition[];
  /** Fields that always come from the bootstrap environment (read-only, never written). */
  readonly environmentPins?: ConnectionEnvironmentPins;
  readonly labelKeys?: ConnectionLabelKeyResolver;
  /** Per-process cache lifetime of `hot` profiles (default 30 s). */
  readonly hotProfileCacheTtlMs?: number;
  /** Config scope of the live encrypted values (default `runtime.connections`). */
  readonly scope?: string;
  /**
   * Environment variable holding the dedicated encryption key (default `CONFIG_ENCRYPTION_KEY`; at least
   * 32 non-blank characters) and variables it must differ from (default `['JWT_SECRET']`).
   */
  readonly encryptionKey?: { readonly variable?: string; readonly distinctFrom?: readonly string[] };
  readonly models?: Partial<Record<SettingsModelKey, string>>;
  readonly tables?: Partial<Record<SettingsTableKey, string>>;
  /** Audit row `module` (default `runtime-settings`) and route prefix recorded as `path` (default `/management/connection-settings`). */
  readonly audit?: { readonly module?: string; readonly path?: string };
  /** Enables `publicIntegrations()` (and, in the module, `GET <publicPath>/integrations`). */
  readonly publicIntegrations?: PublicIntegrationsProjection;
}

/** Extra audit written inside a save's transaction (see `ConnectionSettingsService.withSaveAudit`). */
export type ConnectionSaveAuditHook = (tx: ConnectionTransaction,
  entry: { profileId: string; actorId: string; revision: number; changedFields: readonly string[] }) => Promise<void>;
export type { SecretAction };

/**
 * The narrow, stable part of the service that resolves credentials of an archived revision (payment
 * orders, subscriptions and refunds keep the account they were created on; WP 4.1c). Internal only.
 */
export interface ConnectionCredentialSource {
  currentRevision(profileId: string): Promise<number>;
  revisions(profileId: string): Promise<ReadonlyArray<ArchivedConnectionRevision>>;
  environmentAt(profileId: string, revision: number): Promise<Readonly<NodeJS.ProcessEnv> | undefined>;
  appliedRevision(prefix: string): string | null;
  /** `base`: bootstrap environment (revision 0); `store.deleteRevisions` for operator-run retention purges. */
  readonly runtime: { readonly base: Readonly<NodeJS.ProcessEnv>; readonly store: ConnectionProfileStore };
}

export type ConnectionFieldSource = 'saved' | 'environment' | 'default' | 'cleared' | 'unset';

/**
 * A delegated `config:update` operator must not be able to point an existing credential at a host of
 * their choosing: when an endpoint field of a profile changes, every credential that would still be
 * sent there (saved or supplied by the process environment) has to be re-entered or cleared in the same save.
 */
export function assertSecretsFollowEndpoint(profile: ConnectionProfile, previous: NodeJS.ProcessEnv, candidate: NodeJS.ProcessEnv,
  secrets: Readonly<Record<string, SecretAction>>): void {
  withHttpErrors(() => assertSecretsFollowEndpointRule(profile, previous, candidate, secrets));
}

/**
 * Durable connection settings: a Nest-facing wrapper over `ConnectionRuntime` and `ConnectionProfileStore`
 * from `@zucker-framework/config/connections`. `restart` profiles reach providers only through the frozen
 * start-up snapshot; `hot` profiles are read on demand through `liveEnvironment()` or provider slots
 * (see `HotProvider`). Every saved revision is also kept, encrypted, in the revision archive; only counts
 * ever leave the server. Environment-pinned fields always come from the bootstrap environment.
 */
export class ConnectionSettingsService implements ConnectionCredentialSource {
  private readonly logger = new Logger('ConnectionSettingsService');
  private readonly base: Readonly<NodeJS.ProcessEnv>;
  /** Shared runtime (start-up snapshot, caches, archive access, provider slots). Internal only. */
  readonly runtime: ConnectionRuntime;
  private readonly store: PinnedConnectionProfileStore;
  private readonly saveAudit = new AsyncLocalStorage<ConnectionSaveAuditHook>();
  private readonly definitions: readonly ConnectionProfileDefinition[];
  private readonly pins: ResolvedConnectionPins;
  private readonly labelKeys: ConnectionLabelKeyResolver;
  private readonly keyVariable: string;
  private readonly keyDistinctFrom: readonly string[];
  private readonly projectPublic?: PublicIntegrationsProjection;
  readonly models: ModelNames<SettingsModelKey>;
  constructor(private readonly database: ConnectionDatabase, environment: NodeJS.ProcessEnv, options: ConnectionSettingsServiceOptions) {
    if (!options || !Array.isArray(options.profiles)) throw new TypeError('[back-office/settings] connections.profiles must be an array of connection profile definitions');
    this.base = Object.freeze({ ...environment });
    this.definitions = composeConnectionProfiles(options.profiles);
    this.pins = resolveConnectionPins(this.definitions, options.environmentPins);
    this.labelKeys = options.labelKeys ?? defaultConnectionLabelKeys;
    this.keyVariable = options.encryptionKey?.variable ?? 'CONFIG_ENCRYPTION_KEY';
    this.keyDistinctFrom = options.encryptionKey?.distinctFrom ?? ['JWT_SECRET'];
    this.projectPublic = options.publicIntegrations;
    this.models = resolveModelNames('settings', DEFAULT_SETTINGS_MODELS, options.models);
    const tables = resolveModelNames('settings', DEFAULT_SETTINGS_TABLES, options.tables);
    const auditModule = options.audit?.module ?? 'runtime-settings', auditPath = options.audit?.path ?? '/management/connection-settings';
    this.store = new PinnedConnectionProfileStore({
      scope: options.scope ?? CONNECTION_SETTINGS_SCOPE, definitions: this.definitions,
      archiveTable: tables.connectionRevisions, configTable: tables.config,
      cipher: () => { if (!this.hasKey()) throw connectionStorageUnavailable(); return new SecretCipher({ masterKey: this.base[this.keyVariable]! }); },
      warn: message => this.logger.warn(message),
      audit: async (tx, entry) => {
        const applyMode = entry.definition.applyMode;
        await tx.model(this.models.operationLogs).create({ data: { module: auditModule, action: 'update', status: 'SUCCESS', userId: entry.actorId,
          targetId: entry.definition.profile.id, targetType: 'connection-profile', method: 'PUT', path: `${auditPath}/${entry.definition.profile.id}`,
          metadata: { revision: entry.revision, changedFields: [...entry.changedFields], appliesOn: applyMode === 'hot' ? 'next-request' : 'server-restart', validation: 'local-assembly-only' } } });
        await this.saveAudit.getStore()?.(tx, { profileId: entry.definition.profile.id, actorId: entry.actorId, revision: entry.revision, changedFields: entry.changedFields });
      },
    }, this.pins);
    this.runtime = new ConnectionRuntime({ database, store: this.store, environment: this.base, cacheTtlMs: options.hotProfileCacheTtlMs ?? HOT_PROFILE_CACHE_TTL_MS });
  }
  /** Composed profiles, in display order. */
  get profiles(): readonly ConnectionProfile[] { return this.definitions.map(definition => definition.profile); }
  /** Pinned environment keys of one profile (empty when none). */
  pinnedFields(profileId: string): readonly string[] { return [...(this.pins.get(profileId) ?? [])]; }
  private definition(id: string): ConnectionProfileDefinition {
    const definition = this.definitions.find(row => row.profile.id === id);
    if (!definition) throw new BadRequestException('Unknown connection profile');
    return definition;
  }
  /** Display profile of one id (400 when unknown). */
  profile(id: string): ConnectionProfile { return this.definition(id).profile; }
  /** `hot` or `restart` (400 when unknown). */
  applyMode(id: string): ConnectionApplyMode { return this.definition(id).applyMode; }
  /**
   * Runs `fn` (which performs a save) so that `hook` writes its audit row inside that save's transaction:
   * a rollback leaves neither, and a committed save always has it (used by the D14 data-location guard).
   */
  withSaveAudit<R>(hook: ConnectionSaveAuditHook, fn: () => Promise<R>): Promise<R> {
    return this.saveAudit.run(hook, fn);
  }
  private hasKey(): boolean {
    const key = this.base[this.keyVariable];
    return !!key && key.trim().length >= 32 && !this.keyDistinctFrom.some(name => this.base[name] === key);
  }
  /**
   * Applied revisions of the profiles whose id starts with `prefix`, as `id@revision` pairs (for
   * example the payment configuration a new order is created with). Null before `environment()`.
   */
  appliedRevision(prefix: string): string | null { return this.runtime.appliedRevision(prefix); }
  /** All providers receive this one immutable start-up snapshot. A failed load never falls back to the process environment. */
  environment(): Promise<Readonly<NodeJS.ProcessEnv>> {
    return this.runtime.environment().catch(error => { throw toHttpError(error); });
  }
  /**
   * Current environment for `hot` consumers: the start-up snapshot with every hot profile's fields
   * replaced by its current stored value (base environment as fallback), plus the revisions read.
   * Internal only; never return the environment through HTTP.
   */
  liveEnvironment(): Promise<{ environment: Readonly<NodeJS.ProcessEnv>; revisions: ReadonlyMap<string, number> }> {
    return withHttpErrorsAsync(() => this.runtime.liveEnvironment());
  }
  /** Base environment plus one archived revision of one profile (undefined when not retained). Internal only. */
  environmentAt(profileId: string, revision: number): Promise<Readonly<NodeJS.ProcessEnv> | undefined> {
    return withHttpErrorsAsync(() => this.runtime.environmentAt(profileId, revision));
  }
  /** Retained revisions of one profile, newest first (revision number and creation time only). */
  revisions(profileId: string): Promise<ArchivedConnectionRevision[]> {
    return withHttpErrorsAsync(() => this.runtime.revisions(profileId));
  }
  /** Current stored revision without decryption (0 when never saved). */
  currentRevision(profileId: string): Promise<number> {
    return withHttpErrorsAsync(() => this.runtime.currentRevision(profileId));
  }
  /** A provider slot over the current stored values of `options.profiles` (see `RuntimeProviderSlot`). */
  createSlot<T>(options: RuntimeProviderSlotOptions<T>): RuntimeProviderSlot<T> {
    return withHttpErrors(() => this.runtime.createSlot(options));
  }
  private projection(profile: ConnectionProfile, stored: StoredConnectionProfile, retainedRevisions: number) {
    const applyMode = this.applyMode(profile.id), pinned = this.pins.get(profile.id);
    // A hot profile is live as soon as its save commits (this process) or within the cache TTL (others).
    const appliedRevision = applyMode === 'hot' ? stored.revision : this.runtime.appliedRevisionOf(profile.id) ?? 0;
    const keys = this.labelKeys(profile), hasKey = this.hasKey();
    const fullyPinned = !!pinned && profile.fields.every(field => pinned.has(field.key));
    return { id: profile.id, name: profile.name, labelKey: keys.labelKey, category: profile.category, categoryKey: keys.categoryKey,
      applyMode, appliesOn: applyMode === 'hot' ? 'next-request' as const : 'server-restart' as const,
      storedRevision: stored.revision, appliedRevision,
      pendingRestart: stored.revision !== appliedRevision, canSave: hasKey && !fullyPinned,
      saveUnavailableReason: !hasKey ? 'encryption_key_required' as const : fullyPinned ? 'environment_pinned' as const : null,
      // Number of encrypted archived revisions kept for this profile; the revisions themselves never leave the server.
      retainedRevisions,
      ...(pinned?.size ? { pinnedFields: profile.fields.filter(field => pinned.has(field.key)).map(field => field.key) } : {}),
      fields: profile.fields.map(field => {
        const isPinned = pinned?.has(field.key) === true;
        // `store.read` hides pinned keys, so a pinned field is never "saved" or "cleared".
        const owned = !isPinned && Object.hasOwn(stored.values, field.key), saved = stored.values[field.key], environment = this.base[field.key];
        const source: ConnectionFieldSource = owned ? saved === null ? 'cleared' : 'saved' : environment !== undefined && environment !== '' ? 'environment' : field.defaultValue !== undefined ? 'default' : 'unset';
        const value = owned ? saved ?? field.defaultValue ?? null : environment || field.defaultValue || null;
        return { ...field, ...keys.field(field), configured: value !== null && value !== '', source, ...(field.type === 'secret' ? {} : { value }),
          ...(isPinned ? { pinnedByEnvironment: true as const, readOnly: true as const } : {}) };
      }),
      validation: 'local-assembly-only' as const, externalRequests: false as const };
  }
  /** Whether `GET <publicPath>/integrations` is available (a projection was configured). */
  get publicIntegrationsEnabled(): boolean { return !!this.projectPublic; }
  /** Public website projection of the current (hot) profiles, through the configured projection. */
  async publicIntegrations() {
    if (!this.projectPublic) throw new ServiceUnavailableException('Applied public website configuration is unavailable');
    const { environment, revisions } = await this.liveEnvironment();
    return this.projectPublic(environment, revisions);
  }
  async list() {
    await this.environment();
    const profiles = await withHttpErrorsAsync(() => this.database.transaction(async tx => {
      const counts = await this.store.retainedCounts(tx), result = [];
      for (const { profile } of this.definitions) result.push(this.projection(profile, await this.store.read(tx, profile), counts.get(profile.id) ?? 0));
      return result;
    }));
    // `appliesOn` is per profile (`hot` → 'next-request', `restart` → 'server-restart').
    return { profiles, appliesOn: 'per-profile' as const, externalRequests: false as const };
  }
  async get(id: string) {
    const profile = this.profile(id); await this.environment();
    return withHttpErrorsAsync(() => this.database.transaction(async tx => {
      const counts = await this.store.retainedCounts(tx);
      return this.projection(profile, await this.store.read(tx, profile), counts.get(profile.id) ?? 0);
    }));
  }
  /** Rejects any change of a pinned field (a `keep` action is harmless and dropped). */
  private withoutPinned(profile: ConnectionProfile, update: ConnectionProfileUpdate): ConnectionProfileUpdate {
    const pinned = this.pins.get(profile.id);
    if (!pinned?.size) return update;
    if (profile.fields.every(field => pinned.has(field.key))) throw invalidConnectionInput('Connection profile is pinned by the server environment');
    for (const key of Object.keys(update.values)) if (pinned.has(key)) throw invalidConnectionInput(`${key} is pinned by the server environment`);
    const secrets: Record<string, SecretAction> = {};
    for (const [key, action] of Object.entries(update.secrets)) {
      if (!pinned.has(key)) { secrets[key] = action; continue; }
      if (action.action !== 'keep') throw invalidConnectionInput(`${key} is pinned by the server environment`);
    }
    return { ...update, secrets };
  }
  async save(actorId: string, id: string, body: unknown) {
    if (!actorId) throw new BadRequestException('Authenticated connection operator is required');
    const profile = this.profile(id), update = withHttpErrors(() => this.withoutPinned(profile, parseConnectionUpdate(profile, body)));
    await this.environment();
    if (!this.hasKey()) throw toHttpError(connectionStorageUnavailable());
    const saved = await withHttpErrorsAsync(() => this.runtime.save(actorId, profile.id, update));
    return this.projection(profile, saved.stored, saved.retainedRevisions);
  }
}
