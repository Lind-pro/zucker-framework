import { invalidConnectionInput } from './errors';
import type { ConnectionField, ConnectionProfile, ConnectionProfileDefinition } from './registry';

export type SecretAction = { action: 'keep' | 'clear' } | { action: 'replace'; value: string };
/** A validated update request: plain values (non-secret fields) and explicit secret actions. */
export interface ConnectionProfileUpdate {
  expectedRevision: number;
  values: Record<string, string | null>;
  secrets: Record<string, SecretAction>;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Validates and normalizes one submitted or stored field value. Secrets are kept verbatim; every
 * other type is trimmed. Throws a 400 `ConnectionSettingsError` naming only the field key.
 */
export function validateConnectionField(field: ConnectionField, value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > (field.type === 'secret' ? 16384 : 2048) || /[\u0000-\u001f\u007f]/.test(value)) throw invalidConnectionInput(`Invalid ${field.key}; use an explicit clear action to remove a value`);
  if (field.type === 'boolean' && !['true', 'false'].includes(value) || field.type === 'select' && !field.options?.includes(value)) throw invalidConnectionInput(`Invalid ${field.key} choice`);
  if (field.type === 'number' && (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < (field.min ?? 1) || Number(value) > (field.max ?? Number.MAX_SAFE_INTEGER))) throw invalidConnectionInput(`Invalid ${field.key} number`);
  if (field.type === 'url') {
    try { const url = new URL(value); if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error(); }
    catch { throw invalidConnectionInput(`Invalid ${field.key} URL`); }
  }
  return field.type === 'secret' ? value : value.trim();
}

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
  if (carried.length) throw invalidConnectionInput(`Changing the connection endpoint requires re-entering ${carried.map(field => field.key).join(', ')}`);
}

/** Constructs local options only. No verification request, send, upload or payment is performed. */
export async function validateConnectionProfile(definition: ConnectionProfileDefinition, environment: NodeJS.ProcessEnv): Promise<void> {
  // Validator messages may echo configuration; only this generic message leaves the server.
  try { await definition.validate?.(environment); }
  catch { throw invalidConnectionInput('Connection configuration cannot be assembled locally; check required fields and installed provider support'); }
}

/** Exact-key validation of an untrusted update body (`{ expectedRevision, values?, secrets? }`). */
export function parseConnectionUpdate(profile: ConnectionProfile, body: unknown): ConnectionProfileUpdate {
  if (!record(body) || Object.keys(body).some(key => !['expectedRevision', 'values', 'secrets'].includes(key))
    || !Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 0
    || body.values !== undefined && !record(body.values) || body.secrets !== undefined && !record(body.secrets)) throw invalidConnectionInput('Invalid connection update');
  const values: ConnectionProfileUpdate['values'] = {}, secrets: ConnectionProfileUpdate['secrets'] = {};
  for (const [key, value] of Object.entries(body.values ?? {})) {
    const field = profile.fields.find(item => item.key === key); if (!field || field.type === 'secret') throw invalidConnectionInput('Unknown or protected connection field');
    values[key] = value === null ? null : validateConnectionField(field, value);
  }
  for (const [key, action] of Object.entries(body.secrets ?? {})) {
    const field = profile.fields.find(item => item.key === key);
    if (!field || field.type !== 'secret' || !record(action) || Object.keys(action).some(key => !['action', 'value'].includes(key))
      || !['keep', 'replace', 'clear'].includes(String(action.action)) || action.action !== 'replace' && Object.hasOwn(action, 'value')) throw invalidConnectionInput('Invalid protected connection action');
    secrets[key] = action.action === 'replace' ? { action: 'replace', value: validateConnectionField(field, action.value) } : { action: action.action as 'keep' | 'clear' };
  }
  return { expectedRevision: Number(body.expectedRevision), values, secrets };
}
