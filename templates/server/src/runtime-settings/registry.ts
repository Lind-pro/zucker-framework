/**
 * Connection profile registry. A feature declares its saved connection profile next to its own code
 * with `defineConnectionProfile` and exports it; `connection-settings.descriptors.ts` only composes
 * the exported arrays. Adding a profile therefore never requires editing another feature's file.
 */
export type ConnectionFieldType = 'text' | 'secret' | 'boolean' | 'select' | 'number' | 'url';
export interface ConnectionField {
  key: string; label: string; type: ConnectionFieldType; options?: readonly string[]; defaultValue?: string; description?: string; min?: number; max?: number;
}
export interface ConnectionProfile { id: string; name: string; category: string; fields: readonly ConnectionField[] }
/**
 * `restart`: providers read the frozen startup snapshot (`RUNTIME_ENVIRONMENT`); a save is reported as
 * `pendingRestart` until the next start. `hot`: the profile's only consumer reads it on demand through
 * `ConnectionSettingsService.liveEnvironment()` (30 s per-process cache, invalidated by a local save),
 * so it must never be captured by a long-lived provider/SDK instance.
 */
export type ConnectionApplyMode = 'hot' | 'restart';
export interface ConnectionProfileDefinition {
  readonly profile: ConnectionProfile;
  readonly applyMode: ConnectionApplyMode;
  /**
   * Local assembly check of the candidate environment (no network, no send, no payment). Any throw
   * rejects the save (and a saved profile failing it fails startup); the caller replaces the message
   * with a generic one so validator details never leak.
   */
  readonly validate?: (environment: NodeJS.ProcessEnv) => void | Promise<void>;
}

const PROFILE_ID = /^[a-z][a-z0-9-]{0,62}$/;
const FIELD_KEY = /^[A-Z][A-Z0-9_]{0,127}$/;
const FIELD_TYPES: readonly ConnectionFieldType[] = ['text', 'secret', 'boolean', 'select', 'number', 'url'];

/** Validates the declaration once at module load, so a malformed profile fails startup and tests, not a request. */
export function defineConnectionProfile(definition: ConnectionProfileDefinition): ConnectionProfileDefinition {
  const { profile, applyMode } = definition;
  if (!PROFILE_ID.test(profile.id)) throw new Error(`Invalid connection profile id ${profile.id}`);
  if (applyMode !== 'hot' && applyMode !== 'restart') throw new Error(`Connection profile ${profile.id} needs applyMode 'hot' or 'restart'`);
  if (!profile.fields.length) throw new Error(`Connection profile ${profile.id} has no fields`);
  const keys = new Set<string>();
  for (const field of profile.fields) {
    if (!FIELD_KEY.test(field.key) || keys.has(field.key)) throw new Error(`Invalid or duplicate field ${field.key} in ${profile.id}`);
    if (!FIELD_TYPES.includes(field.type)) throw new Error(`Unsupported field type ${String(field.type)} in ${profile.id}`);
    if (field.type === 'select' && !field.options?.length) throw new Error(`Select field ${field.key} in ${profile.id} needs options`);
    keys.add(field.key);
  }
  return Object.freeze({ ...definition, profile: Object.freeze({ ...profile, fields: Object.freeze([...profile.fields]) }) });
}

/**
 * Concatenates feature arrays in order. Profile ids and environment keys must be unique across all
 * profiles: profiles are merged into one environment, so a shared key would make precedence ambiguous.
 */
export function composeConnectionProfiles(...groups: ReadonlyArray<readonly ConnectionProfileDefinition[]>): readonly ConnectionProfileDefinition[] {
  const all = groups.flat(), ids = new Set<string>(), owners = new Map<string, string>();
  for (const { profile } of all) {
    if (ids.has(profile.id)) throw new Error(`Duplicate connection profile ${profile.id}`);
    ids.add(profile.id);
    for (const field of profile.fields) {
      const owner = owners.get(field.key);
      if (owner) throw new Error(`Connection field ${field.key} is declared by both ${owner} and ${profile.id}`);
      owners.set(field.key, profile.id);
    }
  }
  return Object.freeze(all);
}

/** Field helpers shared by profile declarations. */
export const connectionField = {
  text: (key: string, label: string): ConnectionField => ({ key, label, type: 'text' }),
  secret: (key: string, label: string): ConnectionField => ({ key, label, type: 'secret' }),
  boolean: (key: string, label: string, defaultValue = 'false'): ConnectionField => ({ key, label, type: 'boolean', defaultValue }),
  select: (key: string, label: string, options: string[], defaultValue?: string): ConnectionField => ({ key, label, type: 'select', options, defaultValue }),
  port: (key: string): ConnectionField => ({ key, label: '端口', type: 'number', defaultValue: '587', min: 1, max: 65535 }),
};
