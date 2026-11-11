import type { DatabaseAdapter } from '@zucker-framework/core';
import { ConfigScopeManager } from '../config-scope-manager';
import { ConfigService, type ConfigEncryptor } from '../config.service';
import { ConnectionSettingsError, connectionStorageUnavailable } from './errors';
import { validateConnectionField, type ConnectionProfileUpdate } from './fields';
import type { ConnectionProfile, ConnectionProfileDefinition } from './registry';

/** A database transaction that also runs fixed, parameterized SQL (PostgreSQL). */
export interface ConnectionTransaction extends DatabaseAdapter {
  query<TRow = Record<string, unknown>>(sql: string, values?: readonly unknown[]): Promise<{ rows: TRow[] }>;
}
/** The saved overrides of one profile. `null` means "cleared": the base environment value is removed too. */
export interface StoredConnectionProfile {
  readonly revision: number;
  readonly values: Readonly<Record<string, string | null>>;
}
export interface ArchivedConnectionRevision { readonly revision: number; readonly createdAt: Date }
export interface ConnectionSaveAuditEntry {
  readonly definition: ConnectionProfileDefinition;
  readonly actorId: string;
  readonly previousRevision: number;
  readonly revision: number;
  /** Sorted environment keys whose stored value changed. Never values. */
  readonly changedFields: readonly string[];
}
export interface ConnectionSaveResult {
  readonly stored: StoredConnectionProfile;
  readonly previous: StoredConnectionProfile;
  readonly changed: boolean;
  readonly changedFields: readonly string[];
}
export interface ConnectionProfileStoreOptions {
  /** Config scope that holds the live encrypted values (one key per profile id). */
  readonly scope: string;
  readonly definitions: readonly ConnectionProfileDefinition[];
  /**
   * Encryption for live values and archive rows. A function is called on first use, so an
   * application without a key can still list profiles that were never saved; it should throw
   * `connectionStorageUnavailable()` (or any error, which is reported as such) when no key exists.
   */
  readonly cipher: ConfigEncryptor | (() => ConfigEncryptor);
  /** Runs inside the save transaction after the live value and archive row are written. */
  readonly audit?: (tx: ConnectionTransaction, entry: ConnectionSaveAuditEntry) => Promise<void>;
  /** Archive table name (default `connection_profile_revisions`). */
  readonly archiveTable?: string;
  /** Live config table name (default `config`), used only for the plain current-revision read. */
  readonly configTable?: string;
  /** Receives operational warnings (counts and profile ids only, never values). */
  readonly warn?: (message: string) => void;
}
export interface ConnectionSaveOptions {
  /**
   * Called under the profile lock with the candidate and previous stored values before anything is
   * written. Throwing aborts the save (environment checks, endpoint/secret rule, local assembly).
   */
  readonly verify?: (next: StoredConnectionProfile, previous: StoredConnectionProfile) => Promise<void> | void;
}

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Durable storage of connection profiles: the live value in the config table (encrypted through
 * `ConfigService`, as before) plus an append-only archive of every saved revision, encrypted with the
 * same cipher envelope. All methods take the caller's transaction; `save` takes the per-profile
 * advisory lock itself.
 *
 * Invariants:
 * - Archive rows are never discarded implicitly: they may hold the only copy of credentials an
 *   existing record (a paid order, a refund) still needs. Only `deleteRevisions` removes them.
 * - Revision numbers are never reused. After the live row was deleted out of band, the next save
 *   continues above the highest archived revision; a live value found below the highest archived
 *   revision at start-up (for example a restored `config` row) is re-saved under a new number.
 * - Once the start-up backfill has run, the current revision is the highest archived one.
 */
export class ConnectionProfileStore {
  private readonly scopes = new ConfigScopeManager();
  private readonly archive: string;
  private readonly configTable: string;
  readonly scope: string;
  readonly definitions: readonly ConnectionProfileDefinition[];
  constructor(private readonly options: ConnectionProfileStoreOptions) {
    const archive = options.archiveTable ?? 'connection_profile_revisions', config = options.configTable ?? 'config';
    if (!IDENTIFIER.test(archive) || !IDENTIFIER.test(config)) throw new Error('Invalid connection storage table name');
    this.archive = `"${archive}"`; this.configTable = `"${config}"`;
    this.scope = options.scope; this.definitions = options.definitions;
    this.scopes.register({ id: options.scope, name: 'Protected runtime connections', publicAccess: false, isPublic: false,
      properties: options.definitions.map(({ profile }) => ({ key: profile.id, name: profile.name, type: 'string', defaultValue: undefined,
        description: 'Encrypted application connection profile', readonly: false, encrypted: true })) });
  }
  definition(profileId: string): ConnectionProfileDefinition | undefined {
    return this.definitions.find(row => row.profile.id === profileId);
  }
  private cipher(): ConfigEncryptor {
    try { return typeof this.options.cipher === 'function' ? this.options.cipher() : this.options.cipher; }
    catch (error) { if (error instanceof ConnectionSettingsError) throw error; throw connectionStorageUnavailable(); }
  }
  private configuration(tx: ConnectionTransaction): ConfigService {
    return new ConfigService(tx, undefined, this.scopes, this.cipher());
  }
  /** Transaction-scoped advisory lock per profile; the key format is unchanged from the template. */
  async lock(tx: ConnectionTransaction, profileId: string): Promise<void> {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended(current_schema() || ':' || $1 || ':' || $2, 0))::text AS locked", [this.scope, profileId]);
  }
  /** Parses a decrypted payload; any shape or field violation is reported as unreadable storage. */
  private parse(profile: ConnectionProfile, raw: unknown): StoredConnectionProfile {
    if (typeof raw !== 'string' || !raw) throw new Error();
    const parsed: unknown = JSON.parse(raw);
    if (!record(parsed) || Object.keys(parsed).some(key => !['revision', 'values'].includes(key)) || !Number.isSafeInteger(parsed.revision) || Number(parsed.revision) < 1 || !record(parsed.values)) throw new Error();
    for (const [key, value] of Object.entries(parsed.values)) {
      const field = profile.fields.find(item => item.key === key); if (!field || value !== null && validateConnectionField(field, value) !== value) throw new Error();
    }
    return parsed as unknown as StoredConnectionProfile;
  }
  /** Current saved value; `{ revision: 0, values: {} }` when the profile was never saved. */
  async read(tx: ConnectionTransaction, profile: ConnectionProfile): Promise<StoredConnectionProfile> {
    const existing = await tx.model('config').findUnique({ where: { scope_key: { scope: this.scope, key: profile.id } }, select: { id: true } });
    if (!existing) return { revision: 0, values: {} };
    try { return this.parse(profile, await this.configuration(tx).get<string>(this.scope, profile.id)); }
    catch { throw connectionStorageUnavailable(); }
  }
  /** One archived revision, decrypted and validated; `undefined` when no such row is retained. */
  async readRevision(tx: ConnectionTransaction, profileId: string, revision: number): Promise<StoredConnectionProfile | undefined> {
    const definition = this.definition(profileId);
    if (!definition || !Number.isSafeInteger(revision) || revision < 1) return undefined;
    const { rows } = await tx.query<{ ciphertext: string }>(`SELECT "ciphertext" FROM ${this.archive} WHERE "profileId" = $1 AND "revision" = $2`, [profileId, revision]);
    if (!rows.length) return undefined;
    try {
      const stored = this.parse(definition.profile, await this.cipher().decrypt(rows[0].ciphertext));
      if (stored.revision !== revision) throw new Error();
      return stored;
    } catch { throw connectionStorageUnavailable(); }
  }
  /** Retained revisions of one profile, newest first. Metadata only; nothing is decrypted. */
  async revisions(tx: ConnectionTransaction, profileId: string): Promise<ArchivedConnectionRevision[]> {
    const { rows } = await tx.query<{ revision: number; createdAt: Date }>(`SELECT "revision", "createdAt" FROM ${this.archive} WHERE "profileId" = $1 ORDER BY "revision" DESC`, [profileId]);
    return rows.map(row => ({ revision: Number(row.revision), createdAt: new Date(row.createdAt) }));
  }
  /**
   * Current stored revision without decryption: 0 when there is no live value, otherwise the newest
   * archived revision. Valid once the start-up backfill has run (see `ensureArchived`).
   */
  async currentRevision(tx: ConnectionTransaction, profileId: string): Promise<number> {
    const { rows } = await tx.query<{ revision: number }>(
      `SELECT CASE WHEN EXISTS (SELECT 1 FROM ${this.configTable} c WHERE c."scope" = $1 AND c."key" = $2)
        THEN COALESCE((SELECT max(r."revision") FROM ${this.archive} r WHERE r."profileId" = $2), 0) ELSE 0 END::int AS "revision"`, [this.scope, profileId]);
    return Number(rows[0]?.revision ?? 0);
  }
  /** Number of retained archive rows per profile id (profiles without rows are absent). */
  async retainedCounts(tx: ConnectionTransaction): Promise<Map<string, number>> {
    const { rows } = await tx.query<{ profileId: string; count: number }>(`SELECT "profileId", count(*)::int AS "count" FROM ${this.archive} GROUP BY "profileId"`);
    return new Map(rows.map(row => [row.profileId, Number(row.count)]));
  }
  /** Highest archived revision of one profile (0 when none). */
  private async newestArchived(tx: ConnectionTransaction, profileId: string): Promise<number> {
    const { rows } = await tx.query<{ revision: number | null }>(`SELECT max("revision")::int AS "revision" FROM ${this.archive} WHERE "profileId" = $1`, [profileId]);
    return rows[0]?.revision === null || rows[0]?.revision === undefined ? 0 : Number(rows[0].revision);
  }
  private async append(tx: ConnectionTransaction, profileId: string, stored: StoredConnectionProfile, createdBy: string | null): Promise<void> {
    const ciphertext = await this.cipher().encrypt(JSON.stringify(stored));
    await tx.query(`INSERT INTO ${this.archive} ("profileId", "revision", "ciphertext", "createdBy") VALUES ($1, $2, $3, $4)`, [profileId, stored.revision, ciphertext, createdBy]);
  }
  /**
   * Start-up backfill. Caller holds the profile lock and passes the live value it just read: archives
   * it when its row is missing (databases saved before the archive existed). A live value numbered
   * below the highest archived revision (the live row was restored or rewritten out of band) is
   * re-saved as the next revision instead, so the current revision stays the highest archived one and
   * no archived revision is overwritten or discarded. Returns true when anything was written; the
   * caller must then re-read the live value.
   */
  async ensureArchived(tx: ConnectionTransaction, profileId: string, stored: StoredConnectionProfile): Promise<boolean> {
    if (!stored.revision) return false;
    const newest = await this.newestArchived(tx, profileId);
    if (newest > stored.revision) {
      const definition = this.definition(profileId);
      if (!definition) return false;
      if (newest >= Number.MAX_SAFE_INTEGER) throw new ConnectionSettingsError(409, 'Connection revision limit reached');
      const renumbered: StoredConnectionProfile = { revision: newest + 1, values: stored.values };
      await this.configuration(tx).setProperties(this.scope, { [profileId]: JSON.stringify(renumbered) });
      await this.append(tx, profileId, renumbered, null);
      this.options.warn?.(`Connection profile ${profileId}: live revision ${stored.revision} was below the highest archived revision ${newest}; re-saved as revision ${renumbered.revision}`);
      return true;
    }
    const { rows: present } = await tx.query(`SELECT 1 AS "present" FROM ${this.archive} WHERE "profileId" = $1 AND "revision" = $2`, [profileId, stored.revision]);
    if (present.length) return false;
    await this.append(tx, profileId, stored, null);
    return true;
  }
  /**
   * Compare-and-swap save under the profile lock. Writes the live value, appends the archive row and
   * runs the audit callback in the caller's transaction, so a rollback leaves none of them.
   */
  async save(tx: ConnectionTransaction, definition: ConnectionProfileDefinition, update: ConnectionProfileUpdate, actorId: string,
    options: ConnectionSaveOptions = {}): Promise<ConnectionSaveResult> {
    const { profile } = definition;
    await this.lock(tx, profile.id); const stored = await this.read(tx, profile);
    if (stored.revision !== update.expectedRevision) throw new ConnectionSettingsError(409, 'Connection configuration changed; reload before saving');
    const values: Record<string, string | null> = { ...stored.values, ...update.values };
    for (const [key, action] of Object.entries(update.secrets)) {
      if (action.action === 'replace') values[key] = action.value; else if (action.action === 'clear') values[key] = null;
    }
    const changedFields = Object.keys(values).filter(key => !Object.hasOwn(stored.values, key) || values[key] !== stored.values[key]).sort();
    if (!changedFields.length) return { stored, previous: stored, changed: false, changedFields };
    // Continue above every archived revision (the live row may have been deleted out of band), so an
    // archived revision number keeps meaning the credentials it was first saved with.
    const base = Math.max(stored.revision, await this.newestArchived(tx, profile.id));
    if (base >= Number.MAX_SAFE_INTEGER) throw new ConnectionSettingsError(409, 'Connection revision limit reached');
    const next: StoredConnectionProfile = { revision: base + 1, values };
    await options.verify?.(next, stored);
    await this.configuration(tx).setProperties(this.scope, { [profile.id]: JSON.stringify(next) });
    await this.append(tx, profile.id, next, actorId);
    await this.options.audit?.(tx, { definition, actorId, previousRevision: stored.revision, revision: next.revision, changedFields });
    return { stored: next, previous: stored, changed: true, changedFields };
  }
  /**
   * Deletes the given archived revisions of one profile under its lock. The current revision is never
   * deleted (it is skipped). Returns the revisions actually deleted. Retention policy (which revisions
   * are unreferenced and old enough) belongs to the caller.
   */
  async deleteRevisions(tx: ConnectionTransaction, profileId: string, revisions: readonly number[]): Promise<number[]> {
    await this.lock(tx, profileId);
    const current = await this.currentRevision(tx, profileId), deleted: number[] = [];
    for (const revision of new Set(revisions)) {
      if (!Number.isSafeInteger(revision) || revision < 1 || revision === current) continue;
      const { rows } = await tx.query(`DELETE FROM ${this.archive} WHERE "profileId" = $1 AND "revision" = $2 RETURNING "revision"`, [profileId, revision]);
      if (rows.length) deleted.push(revision);
    }
    return deleted.sort((a, b) => a - b);
  }
}
