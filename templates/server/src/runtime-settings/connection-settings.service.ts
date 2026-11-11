import { BadRequestException, Logger } from '@nestjs/common';
import {
  assertSecretsFollowEndpoint as assertSecretsFollowEndpointRule, connectionEndpointField, connectionStorageUnavailable, ConnectionProfileStore,
  ConnectionRuntime, parseConnectionUpdate, type ArchivedConnectionRevision, type RuntimeProviderSlot, type RuntimeProviderSlotOptions,
  type SecretAction, type StoredConnectionProfile, type ConnectionTransaction,
} from '@zucker-framework/config/connections';
import { SecretCipher } from '@zucker-framework/core';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ApplicationDatabase } from '../database';
import { toHttpError, withHttpErrors, withHttpErrorsAsync } from './connection-errors';
import { CONNECTION_PROFILE_DEFINITIONS, CONNECTION_PROFILES, connectionApplyMode, connectionLabelKeys, connectionProfile, type ConnectionProfile } from './connection-settings.descriptors';
import { appliedPublicSiteConfiguration } from './site-public.config';

export const CONNECTION_SETTINGS_SCOPE = 'runtime.connections';
/**
 * Upper bound on how long another replica may serve a superseded `hot` profile. The saving process
 * invalidates its own cache when the save commits; there is no cross-replica invalidation.
 */
export const HOT_PROFILE_CACHE_TTL_MS = 30_000;
export interface ConnectionSettingsOptions { hotProfileCacheTtlMs?: number }
/** Extra audit written inside a save's transaction (see `ConnectionSettingsService.withSaveAudit`). */
export type ConnectionSaveAuditHook = (tx: ConnectionTransaction,
  entry: { profileId: string; actorId: string; revision: number; changedFields: readonly string[] }) => Promise<void>;
export type { SecretAction };
export { connectionEndpointField };

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
 * Application-owned durable configuration: a thin Nest-facing wrapper over `ConnectionRuntime` and
 * `ConnectionProfileStore` from `@zucker-framework/config/connections`. `restart` profiles reach
 * providers only through the frozen startup snapshot, which never changes after initialization. `hot`
 * profiles are additionally readable on demand through `liveEnvironment()`. Every saved revision is
 * also kept, encrypted, in `connection_profile_revisions`; only counts ever leave the server.
 */
export class ConnectionSettingsService {
  private readonly logger = new Logger(ConnectionSettingsService.name);
  private readonly base: Readonly<NodeJS.ProcessEnv>;
  /** Shared runtime (start-up snapshot, caches, archive access, provider slots). Internal only. */
  readonly runtime: ConnectionRuntime;
  private readonly store: ConnectionProfileStore;
  private readonly saveAudit = new AsyncLocalStorage<ConnectionSaveAuditHook>();
  constructor(private readonly database: ApplicationDatabase, environment: NodeJS.ProcessEnv, options: ConnectionSettingsOptions = {}) {
    this.base = Object.freeze({ ...environment });
    this.store = new ConnectionProfileStore({
      scope: CONNECTION_SETTINGS_SCOPE, definitions: CONNECTION_PROFILE_DEFINITIONS,
      cipher: () => { if (!this.hasKey()) throw connectionStorageUnavailable(); return new SecretCipher({ masterKey: this.base.CONFIG_ENCRYPTION_KEY! }); },
      warn: message => this.logger.warn(message),
      audit: async (tx, entry) => {
        const applyMode = entry.definition.applyMode;
        await tx.model('operationLogs').create({ data: { module: 'runtime-settings', action: 'update', status: 'SUCCESS', userId: entry.actorId,
          targetId: entry.definition.profile.id, targetType: 'connection-profile', method: 'PUT', path: `/management/connection-settings/${entry.definition.profile.id}`,
          metadata: { revision: entry.revision, changedFields: [...entry.changedFields], appliesOn: applyMode === 'hot' ? 'next-request' : 'server-restart', validation: 'local-assembly-only' } } });
        await this.saveAudit.getStore()?.(tx, { profileId: entry.definition.profile.id, actorId: entry.actorId, revision: entry.revision, changedFields: entry.changedFields });
      },
    });
    this.runtime = new ConnectionRuntime({ database, store: this.store, environment: this.base, cacheTtlMs: options.hotProfileCacheTtlMs ?? HOT_PROFILE_CACHE_TTL_MS });
  }
  /**
   * Runs `fn` (which performs a save) so that `hook` writes its audit row inside that save's transaction:
   * a rollback leaves neither, and a committed save always has it. Used by the D14 storage guard.
   */
  withSaveAudit<R>(hook: ConnectionSaveAuditHook, fn: () => Promise<R>): Promise<R> {
    return this.saveAudit.run(hook, fn);
  }
  private hasKey(): boolean {
    return !!this.base.CONFIG_ENCRYPTION_KEY && this.base.CONFIG_ENCRYPTION_KEY.trim().length >= 32 && this.base.CONFIG_ENCRYPTION_KEY !== this.base.JWT_SECRET;
  }
  /**
   * Applied revisions of the profiles whose id starts with `prefix`, as `id@revision` pairs (for
   * example the payment configuration a new order is created with). Null before `environment()`.
   */
  appliedRevision(prefix: string): string | null { return this.runtime.appliedRevision(prefix); }
  /** All providers receive this one immutable startup snapshot. A failed load never falls back to process.env. */
  environment(): Promise<Readonly<NodeJS.ProcessEnv>> {
    return this.runtime.environment().catch(error => { throw toHttpError(error); });
  }
  /**
   * Current environment for `hot` consumers: the startup snapshot with every hot profile's fields
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
    const applyMode = connectionApplyMode(profile.id);
    // A hot profile is live as soon as its save commits (this process) or within the cache TTL (others).
    const appliedRevision = applyMode === 'hot' ? stored.revision : this.runtime.appliedRevisionOf(profile.id) ?? 0;
    const keys = connectionLabelKeys(profile);
    return { id: profile.id, name: profile.name, labelKey: keys.labelKey, category: profile.category, categoryKey: keys.categoryKey,
      applyMode, appliesOn: applyMode === 'hot' ? 'next-request' as const : 'server-restart' as const,
      storedRevision: stored.revision, appliedRevision,
      pendingRestart: stored.revision !== appliedRevision, canSave: this.hasKey(), saveUnavailableReason: this.hasKey() ? null : 'encryption_key_required',
      // Number of encrypted archived revisions kept for this profile; the revisions themselves never leave the server.
      retainedRevisions,
      fields: profile.fields.map(field => {
        const owned = Object.hasOwn(stored.values, field.key), saved = stored.values[field.key], environment = this.base[field.key];
        const source = owned ? saved === null ? 'cleared' : 'saved' : environment !== undefined && environment !== '' ? 'environment' : field.defaultValue !== undefined ? 'default' : 'unset';
        const value = owned ? saved ?? field.defaultValue ?? null : environment || field.defaultValue || null;
        return { ...field, ...keys.field(field), configured: value !== null && value !== '', source, ...(field.type === 'secret' ? {} : { value }) };
      }),
      validation: 'local-assembly-only' as const, externalRequests: false as const };
  }
  /** Public website projection of the current (hot) `web-analytics` and `web-connections` profiles. */
  async publicIntegrations() {
    const { environment, revisions } = await this.liveEnvironment();
    return { ...appliedPublicSiteConfiguration(environment), revisions: { analytics: revisions.get('web-analytics') ?? 0, connections: revisions.get('web-connections') ?? 0 } };
  }
  async list() {
    await this.environment();
    const profiles = await withHttpErrorsAsync(() => this.database.transaction(async tx => {
      const counts = await this.store.retainedCounts(tx), result = [];
      for (const profile of CONNECTION_PROFILES) result.push(this.projection(profile, await this.store.read(tx, profile), counts.get(profile.id) ?? 0));
      return result;
    }));
    // `appliesOn` is per profile (`hot` → 'next-request', `restart` → 'server-restart').
    return { profiles, appliesOn: 'per-profile' as const, externalRequests: false as const };
  }
  async get(id: string) {
    const profile = connectionProfile(id); await this.environment();
    return withHttpErrorsAsync(() => this.database.transaction(async tx => {
      const counts = await this.store.retainedCounts(tx);
      return this.projection(profile, await this.store.read(tx, profile), counts.get(profile.id) ?? 0);
    }));
  }
  async save(actorId: string, id: string, body: unknown) {
    if (!actorId) throw new BadRequestException('Authenticated connection operator is required');
    const profile = connectionProfile(id), update = withHttpErrors(() => parseConnectionUpdate(profile, body)); await this.environment();
    if (!this.hasKey()) throw toHttpError(connectionStorageUnavailable());
    const saved = await withHttpErrorsAsync(() => this.runtime.save(actorId, profile.id, update));
    return this.projection(profile, saved.stored, saved.retainedRevisions);
  }
}
