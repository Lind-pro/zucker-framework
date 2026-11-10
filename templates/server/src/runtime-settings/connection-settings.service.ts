import { BadRequestException, ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigScopeManager, ConfigService } from '@zucker-framework/config';
import { SecretCipher } from '@zucker-framework/core';
import { ApplicationDatabase, type ApplicationTransaction } from '../database';
import { CONNECTION_PROFILES, connectionApplyMode, connectionLabelKeys, connectionProfile, validateConnection, validateField, type ConnectionField, type ConnectionProfile } from './connection-settings.descriptors';
import { appliedPublicSiteConfiguration } from './site-public.config';

export const CONNECTION_SETTINGS_SCOPE = 'runtime.connections';
/**
 * Upper bound on how long another replica may serve a superseded `hot` profile. The saving process
 * invalidates its own cache when the save commits; there is no cross-replica invalidation.
 */
export const HOT_PROFILE_CACHE_TTL_MS = 30_000;
export interface ConnectionSettingsOptions { hotProfileCacheTtlMs?: number }
interface StoredProfile { revision: number; values: Record<string, string | null> }
export type SecretAction = { action: 'keep' | 'clear' } | { action: 'replace'; value: string };
interface Update { expectedRevision: number; values: Record<string, string | null>; secrets: Record<string, SecretAction> }
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function storageUnavailable(): ServiceUnavailableException { return new ServiceUnavailableException('Saved connection configuration cannot be read; check the dedicated encryption key and stored configuration'); }

/** Fields that decide where a profile's credentials are sent (API base URL, SMTP host, S3 endpoint). */
export function connectionEndpointField(field: ConnectionField): boolean {
  return field.type === 'url' || /_(?:HOST|ENDPOINT|BASE_URL)$/.test(field.key);
}
/**
 * A delegated `config:update` operator must not be able to point an existing credential at a host of
 * their choosing: when an endpoint field of a profile changes, every credential that would still be
 * sent there (saved or supplied by the process environment) has to be re-entered or cleared in the same save.
 */
export function assertSecretsFollowEndpoint(profile: ConnectionProfile, previous: NodeJS.ProcessEnv, candidate: NodeJS.ProcessEnv,
  secrets: Readonly<Record<string, SecretAction>>): void {
  const effective = (env: NodeJS.ProcessEnv, field: ConnectionField) => env[field.key] || field.defaultValue || '';
  const moved = profile.fields.some(field => connectionEndpointField(field) && effective(previous, field) !== effective(candidate, field));
  if (!moved) return;
  const carried = profile.fields.filter(field => field.type === 'secret' && !!candidate[field.key] && secrets[field.key]?.action !== 'replace');
  if (carried.length) throw new BadRequestException(`Changing the connection endpoint requires re-entering ${carried.map(field => field.key).join(', ')}`);
}

/**
 * Application-owned durable configuration. `restart` profiles reach providers only through the frozen
 * startup snapshot, which never changes after initialization. `hot` profiles are additionally readable
 * on demand through `liveEnvironment()`.
 */
export class ConnectionSettingsService {
  private readonly base: NodeJS.ProcessEnv;
  private readonly scopes = new ConfigScopeManager();
  private readonly applied = new Map<string, number>();
  private snapshot?: Promise<Readonly<NodeJS.ProcessEnv>>;
  private readonly hotTtlMs: number;
  /** Per hot profile: the cached stored value and a generation bumped by every local save. */
  private readonly hot = new Map<string, { expires: number; value: Promise<StoredProfile> }>();
  private readonly hotGeneration = new Map<string, number>();
  constructor(private readonly database: ApplicationDatabase, environment: NodeJS.ProcessEnv, options: ConnectionSettingsOptions = {}) {
    this.base = Object.freeze({ ...environment });
    this.hotTtlMs = options.hotProfileCacheTtlMs ?? HOT_PROFILE_CACHE_TTL_MS;
    this.scopes.register({ id: CONNECTION_SETTINGS_SCOPE, name: 'Protected runtime connections', publicAccess: false, isPublic: false,
      properties: CONNECTION_PROFILES.map(profile => ({ key: profile.id, name: profile.name, type: 'string', defaultValue: undefined,
        description: 'Encrypted application connection profile', readonly: false, encrypted: true })) });
  }
  private hasKey(): boolean {
    return !!this.base.CONFIG_ENCRYPTION_KEY && this.base.CONFIG_ENCRYPTION_KEY.trim().length >= 32 && this.base.CONFIG_ENCRYPTION_KEY !== this.base.JWT_SECRET;
  }
  private configuration(tx: ApplicationTransaction): ConfigService {
    if (!this.hasKey()) throw storageUnavailable();
    return new ConfigService(tx, undefined, this.scopes, new SecretCipher({ masterKey: this.base.CONFIG_ENCRYPTION_KEY! }));
  }
  private async lock(tx: ApplicationTransaction, id: string): Promise<void> {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended(current_schema() || ':runtime.connections:' || $1, 0))::text AS locked", [id]);
  }
  private async read(tx: ApplicationTransaction, profile: ConnectionProfile): Promise<StoredProfile> {
    const existing = await tx.model('config').findUnique({ where: { scope_key: { scope: CONNECTION_SETTINGS_SCOPE, key: profile.id } }, select: { id: true } });
    if (!existing) return { revision: 0, values: {} };
    try {
      const raw = await this.configuration(tx).get<string>(CONNECTION_SETTINGS_SCOPE, profile.id);
      if (!raw) throw new Error();
      const parsed: unknown = JSON.parse(raw);
      if (!record(parsed) || Object.keys(parsed).some(key => !['revision', 'values'].includes(key)) || !Number.isSafeInteger(parsed.revision) || Number(parsed.revision) < 1 || !record(parsed.values)) throw new Error();
      for (const [key, value] of Object.entries(parsed.values)) {
        const field = profile.fields.find(item => item.key === key); if (!field || value !== null && validateField(field, value) !== value) throw new Error();
      }
      return parsed as unknown as StoredProfile;
    } catch { throw storageUnavailable(); }
  }
  private merge(env: NodeJS.ProcessEnv, stored: StoredProfile): void {
    for (const [key, value] of Object.entries(stored.values)) {
      if (value === null) delete env[key]; else env[key] = value;
    }
  }
  /**
   * Applied revisions of the profiles whose id starts with `prefix`, as `id@revision` pairs (for
   * example the payment configuration a new order is created with). Null before `environment()`.
   */
  appliedRevision(prefix: string): string | null {
    const entries = [...this.applied].filter(([id]) => id.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b));
    return entries.length ? entries.map(([id, revision]) => `${id}@${revision}`).join(',') : null;
  }
  /** All providers receive this one immutable startup snapshot. A failed load never falls back to process.env. */
  environment(): Promise<Readonly<NodeJS.ProcessEnv>> {
    this.snapshot ??= this.database.transaction(async tx => {
      for (const profile of CONNECTION_PROFILES) await this.lock(tx, profile.id);
      const env = { ...this.base }, revisions = new Map<string, number>(), saved: ConnectionProfile[] = [];
      for (const profile of CONNECTION_PROFILES) {
        const stored = await this.read(tx, profile); this.merge(env, stored); revisions.set(profile.id, stored.revision);
        if (stored.revision) saved.push(profile);
      }
      for (const profile of saved) await validateConnection(profile, env);
      for (const [id, revision] of revisions) this.applied.set(id, revision);
      return Object.freeze(env);
    });
    return this.snapshot;
  }
  /** Stored value of one hot profile, read through the per-process cache. Rejections are never cached. */
  private hotProfile(profile: ConnectionProfile): Promise<StoredProfile> {
    const cached = this.hot.get(profile.id), now = Date.now();
    if (cached && cached.expires > now) return cached.value;
    const generation = this.hotGeneration.get(profile.id) ?? 0;
    const value = this.database.transaction(tx => this.read(tx, profile));
    this.hot.set(profile.id, { expires: now + this.hotTtlMs, value });
    value.catch(() => { if (this.hot.get(profile.id)?.value === value) this.hot.delete(profile.id); });
    // A save that committed while this read was in flight must not be overwritten by the older result.
    void value.then(() => { if ((this.hotGeneration.get(profile.id) ?? 0) !== generation && this.hot.get(profile.id)?.value === value) this.hot.delete(profile.id); }, () => undefined);
    return value;
  }
  private invalidateHot(id: string): void {
    this.hotGeneration.set(id, (this.hotGeneration.get(id) ?? 0) + 1); this.hot.delete(id);
  }
  /**
   * Current environment for `hot` consumers: the startup snapshot with every hot profile's fields
   * replaced by its current stored value (base environment as fallback), plus the revisions read.
   * Internal only; never return the environment through HTTP.
   */
  async liveEnvironment(): Promise<{ environment: Readonly<NodeJS.ProcessEnv>; revisions: ReadonlyMap<string, number> }> {
    const env = { ...await this.environment() }, revisions = new Map<string, number>();
    for (const profile of CONNECTION_PROFILES.filter(row => connectionApplyMode(row.id) === 'hot')) {
      const stored = await this.hotProfile(profile);
      for (const field of profile.fields) { if (this.base[field.key] === undefined) delete env[field.key]; else env[field.key] = this.base[field.key]; }
      this.merge(env, stored); revisions.set(profile.id, stored.revision);
    }
    return { environment: Object.freeze(env), revisions };
  }
  private projection(profile: ConnectionProfile, stored: StoredProfile) {
    const applyMode = connectionApplyMode(profile.id);
    // A hot profile is live as soon as its save commits (this process) or within the cache TTL (others).
    const appliedRevision = applyMode === 'hot' ? stored.revision : this.applied.get(profile.id) ?? 0;
    const keys = connectionLabelKeys(profile);
    return { id: profile.id, name: profile.name, labelKey: keys.labelKey, category: profile.category, categoryKey: keys.categoryKey,
      applyMode, appliesOn: applyMode === 'hot' ? 'next-request' as const : 'server-restart' as const,
      storedRevision: stored.revision, appliedRevision,
      pendingRestart: stored.revision !== appliedRevision, canSave: this.hasKey(), saveUnavailableReason: this.hasKey() ? null : 'encryption_key_required',
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
    const profiles = await this.database.transaction(async tx => {
      const result = []; for (const profile of CONNECTION_PROFILES) result.push(this.projection(profile, await this.read(tx, profile))); return result;
    });
    // `appliesOn` is per profile (`hot` → 'next-request', `restart` → 'server-restart').
    return { profiles, appliesOn: 'per-profile' as const, externalRequests: false as const };
  }
  async get(id: string) {
    const profile = connectionProfile(id); await this.environment();
    return this.database.transaction(async tx => this.projection(profile, await this.read(tx, profile)));
  }
  private update(profile: ConnectionProfile, body: unknown): Update {
    if (!record(body) || Object.keys(body).some(key => !['expectedRevision', 'values', 'secrets'].includes(key))
      || !Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 0
      || body.values !== undefined && !record(body.values) || body.secrets !== undefined && !record(body.secrets)) throw new BadRequestException('Invalid connection update');
    const values: Update['values'] = {}, secrets: Update['secrets'] = {};
    for (const [key, value] of Object.entries(body.values ?? {})) {
      const field = profile.fields.find(item => item.key === key); if (!field || field.type === 'secret') throw new BadRequestException('Unknown or protected connection field');
      values[key] = value === null ? null : validateField(field, value);
    }
    for (const [key, action] of Object.entries(body.secrets ?? {})) {
      const field = profile.fields.find(item => item.key === key);
      if (!field || field.type !== 'secret' || !record(action) || Object.keys(action).some(key => !['action', 'value'].includes(key))
        || !['keep', 'replace', 'clear'].includes(String(action.action)) || action.action !== 'replace' && Object.hasOwn(action, 'value')) throw new BadRequestException('Invalid protected connection action');
      secrets[key] = action.action === 'replace' ? { action: 'replace', value: validateField(field, action.value) } : { action: action.action as 'keep' | 'clear' };
    }
    return { expectedRevision: Number(body.expectedRevision), values, secrets };
  }
  async save(actorId: string, id: string, body: unknown) {
    if (!actorId) throw new BadRequestException('Authenticated connection operator is required');
    const profile = connectionProfile(id), update = this.update(profile, body); await this.environment();
    if (!this.hasKey()) throw storageUnavailable();
    const applyMode = connectionApplyMode(profile.id);
    const saved = await this.database.transaction(async tx => {
      await this.lock(tx, profile.id); const stored = await this.read(tx, profile);
      if (stored.revision !== update.expectedRevision) throw new ConflictException('Connection configuration changed; reload before saving');
      const values = { ...stored.values, ...update.values };
      for (const [key, action] of Object.entries(update.secrets)) {
        if (action.action === 'replace') values[key] = action.value; else if (action.action === 'clear') values[key] = null;
      }
      const changedFields = Object.keys(values).filter(key => !Object.hasOwn(stored.values, key) || values[key] !== stored.values[key]).sort();
      if (!changedFields.length) return this.projection(profile, stored);
      if (stored.revision >= Number.MAX_SAFE_INTEGER) throw new ConflictException('Connection revision limit reached');
      const next = { revision: stored.revision + 1, values }, candidate = { ...this.base }; this.merge(candidate, next);
      const previous = { ...this.base }; this.merge(previous, stored);
      assertSecretsFollowEndpoint(profile, previous, candidate, update.secrets);
      await validateConnection(profile, candidate);
      await this.configuration(tx).setProperties(CONNECTION_SETTINGS_SCOPE, { [profile.id]: JSON.stringify(next) });
      await tx.model('operationLogs').create({ data: { module: 'runtime-settings', action: 'update', status: 'SUCCESS', userId: actorId,
        targetId: profile.id, targetType: 'connection-profile', method: 'PUT', path: `/management/connection-settings/${profile.id}`,
        metadata: { revision: next.revision, changedFields, appliesOn: applyMode === 'hot' ? 'next-request' : 'server-restart', validation: 'local-assembly-only' } } });
      return this.projection(profile, next);
    });
    // Invalidate only after the commit, so the next read in this process sees the new revision.
    if (applyMode === 'hot') this.invalidateHot(profile.id);
    return saved;
  }
}
