import { BadRequestException, ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigScopeManager, ConfigService } from '@zucker-framework/config';
import { SecretCipher } from '@zucker-framework/core';
import { ApplicationDatabase, type ApplicationTransaction } from '../database';
import { CONNECTION_PROFILES, connectionLabelKeys, connectionProfile, validateConnection, validateField, type ConnectionProfile } from './connection-settings.descriptors';

import { appliedPublicSiteConfiguration } from './site-public.config';

export const CONNECTION_SETTINGS_SCOPE = 'runtime.connections';
interface StoredProfile { revision: number; values: Record<string, string | null> }
type SecretAction = { action: 'keep' | 'clear' } | { action: 'replace'; value: string };
interface Update { expectedRevision: number; values: Record<string, string | null>; secrets: Record<string, SecretAction> }
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function storageUnavailable(): ServiceUnavailableException { return new ServiceUnavailableException('Saved connection configuration cannot be read; check the dedicated encryption key and stored configuration'); }

/** Application-owned durable configuration; the running provider environment never changes after initialization. */
export class ConnectionSettingsService {
  private readonly base: NodeJS.ProcessEnv;
  private readonly scopes = new ConfigScopeManager();
  private readonly applied = new Map<string, number>();
  private snapshot?: Promise<Readonly<NodeJS.ProcessEnv>>;
  constructor(private readonly database: ApplicationDatabase, environment: NodeJS.ProcessEnv) {
    this.base = Object.freeze({ ...environment });
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
  private projection(profile: ConnectionProfile, stored: StoredProfile) {
    const appliedRevision = this.applied.get(profile.id) ?? 0;
    const keys = connectionLabelKeys(profile);
    return { id: profile.id, name: profile.name, labelKey: keys.labelKey, category: profile.category, categoryKey: keys.categoryKey,
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
  async publicIntegrations() {
    const env = await this.environment();
    return { ...appliedPublicSiteConfiguration(env), revisions: { analytics: this.applied.get('web-analytics') ?? 0, connections: this.applied.get('web-connections') ?? 0 } };
  }
  async list() {
    await this.environment();
    const profiles = await this.database.transaction(async tx => {
      const result = []; for (const profile of CONNECTION_PROFILES) result.push(this.projection(profile, await this.read(tx, profile))); return result;
    });
    return { profiles, appliesOn: 'server-restart' as const, externalRequests: false as const };
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
    return this.database.transaction(async tx => {
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
      await validateConnection(profile, candidate);
      await this.configuration(tx).setProperties(CONNECTION_SETTINGS_SCOPE, { [profile.id]: JSON.stringify(next) });
      await tx.model('operationLogs').create({ data: { module: 'runtime-settings', action: 'update', status: 'SUCCESS', userId: actorId,
        targetId: profile.id, targetType: 'connection-profile', method: 'PUT', path: `/management/connection-settings/${profile.id}`,
        metadata: { revision: next.revision, changedFields, appliesOn: 'server-restart', validation: 'local-assembly-only' } } });
      return this.projection(profile, next);
    });
  }
}
