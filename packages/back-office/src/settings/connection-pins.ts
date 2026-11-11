import {
  ConnectionProfileStore, type ConnectionProfile, type ConnectionProfileDefinition, type ConnectionProfileStoreOptions,
  type ConnectionTransaction, type StoredConnectionProfile,
} from '@zucker-framework/config/connections';

/**
 * Environment pins per profile id: `true` pins every field of the profile, an array pins the listed
 * environment keys. A pinned field always takes its value from the bootstrap environment: it is shown
 * read-only to administrators, a save that touches it is rejected, and it is never written to the database.
 */
export type ConnectionEnvironmentPins = Readonly<Record<string, true | readonly string[]>>;
/** Resolved pins: profile id → pinned environment keys (only profiles with at least one pin). */
export type ResolvedConnectionPins = ReadonlyMap<string, ReadonlySet<string>>;

const fail = (message: string): never => { throw new TypeError(`[back-office/settings] ${message}`); };

/** Validates the pin declaration against the composed profiles; unknown profiles or keys fail at start-up. */
export function resolveConnectionPins(definitions: readonly ConnectionProfileDefinition[], pins: ConnectionEnvironmentPins | undefined): ResolvedConnectionPins {
  const result = new Map<string, ReadonlySet<string>>();
  if (pins === undefined) return result;
  if (!pins || typeof pins !== 'object' || Array.isArray(pins)) fail('connections.environmentPins must be an object');
  for (const [profileId, value] of Object.entries(pins)) {
    const definition = definitions.find(row => row.profile.id === profileId);
    if (!definition) fail(`connections.environmentPins names unknown profile "${profileId}"`);
    const keys = definition!.profile.fields.map(field => field.key);
    if (value === true) { result.set(profileId, new Set(keys)); continue; }
    if (!Array.isArray(value) || !value.length) fail(`connections.environmentPins.${profileId} must be true or a non-empty array of field keys`);
    for (const key of value as readonly string[]) if (!keys.includes(key)) fail(`connections.environmentPins.${profileId} names unknown field "${String(key)}"`);
    result.set(profileId, new Set(value as readonly string[]));
  }
  return result;
}

/** Returns `stored` without the pinned keys (the same object when nothing is pinned or stored for them). */
export function withoutPinnedValues(stored: StoredConnectionProfile, pinned: ReadonlySet<string> | undefined): StoredConnectionProfile {
  if (!pinned?.size || !Object.keys(stored.values).some(key => pinned.has(key))) return stored;
  return { revision: stored.revision, values: Object.fromEntries(Object.entries(stored.values).filter(([key]) => !pinned.has(key))) };
}

/**
 * `ConnectionProfileStore` that hides pinned keys from every read. Because the runtime merges stored
 * values over the base environment, a hidden key falls back to the base environment everywhere (start-up
 * snapshot, live environment, archived revisions, provider slots, save verification), and a save writes
 * the read values plus the update, so a value saved before the field was pinned is dropped by the next
 * save instead of being written again. The start-up archive backfill still sees the raw live value, so an
 * archived revision always equals what was saved under that number.
 */
export class PinnedConnectionProfileStore extends ConnectionProfileStore {
  constructor(options: ConnectionProfileStoreOptions, private readonly pins: ResolvedConnectionPins) { super(options); }
  override async read(tx: ConnectionTransaction, profile: ConnectionProfile): Promise<StoredConnectionProfile> {
    return withoutPinnedValues(await super.read(tx, profile), this.pins.get(profile.id));
  }
  override async readRevision(tx: ConnectionTransaction, profileId: string, revision: number): Promise<StoredConnectionProfile | undefined> {
    const stored = await super.readRevision(tx, profileId, revision);
    return stored && withoutPinnedValues(stored, this.pins.get(profileId));
  }
  override async ensureArchived(tx: ConnectionTransaction, profileId: string, stored: StoredConnectionProfile): Promise<boolean> {
    const definition = this.definition(profileId);
    const raw = definition && this.pins.has(profileId) ? await super.read(tx, definition.profile) : stored;
    return super.ensureArchived(tx, profileId, raw);
  }
}
