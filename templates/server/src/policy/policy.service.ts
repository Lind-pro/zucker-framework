import { BadRequestException, ConflictException, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigScopeManager, ConfigService } from '@zucker-framework/config';
import { ApplicationDatabase, type ApplicationTransaction } from '../database';
import {
  parsePolicyEnvironmentValue, policyEnvironmentKey, policyFieldValue, PolicyValueError,
  type PolicyDefinition, type PolicyField, type PolicyValue, type PolicyValues,
} from './policy.registry';

export const POLICY_SCOPE = 'runtime.policy';
/** Upper bound on cross-replica staleness; the saving process invalidates its own cache on commit. */
export const POLICY_CACHE_TTL_MS = 30_000;
export interface PolicyServiceOptions { cacheTtlMs?: number }

interface StoredPolicy { revision: number; values: Record<string, PolicyValue> }
interface Resolved { revision: number; values: PolicyValues; saved: Readonly<Record<string, PolicyValue>> }
interface Update { expectedRevision: number; values: Record<string, PolicyValue | null> }
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function storageUnavailable(): ServiceUnavailableException { return new ServiceUnavailableException('Saved policy configuration cannot be read'); }

/**
 * Hot-applied product policies. Precedence per field: environment pin (`POLICY_<ID>_<KEY>`) > saved
 * value > declared default. Saved values are plain JSON `{revision, values}` in config scope
 * `runtime.policy` (one row per policy), written under a per-policy advisory lock with an
 * `expectedRevision` compare-and-swap and an `operationLogs` audit row in the same transaction.
 */
export class PolicyService {
  private readonly logger = new Logger(PolicyService.name);
  private readonly definitions: ReadonlyMap<string, PolicyDefinition>;
  private readonly pins = new Map<string, Readonly<Record<string, PolicyValue>>>();
  private readonly scopes = new ConfigScopeManager();
  private readonly ttlMs: number;
  private readonly cache = new Map<string, { expires: number; value: Promise<Resolved> }>();
  private readonly generation = new Map<string, number>();

  constructor(private readonly database: ApplicationDatabase, policies: readonly PolicyDefinition[], environment: Readonly<NodeJS.ProcessEnv>,
    options: PolicyServiceOptions = {}) {
    this.ttlMs = options.cacheTtlMs ?? POLICY_CACHE_TTL_MS;
    const definitions = new Map<string, PolicyDefinition>();
    for (const policy of policies) {
      if (definitions.has(policy.id)) throw new Error(`Duplicate policy ${policy.id}`);
      definitions.set(policy.id, policy);
      // Pins are parsed at startup: an invalid pin fails the boot instead of a later request.
      const pinned: Record<string, PolicyValue> = {};
      for (const field of policy.fields) {
        const name = policyEnvironmentKey(policy.id, field.key), raw = environment[name];
        if (raw === undefined || raw === '') continue;
        try { pinned[field.key] = parsePolicyEnvironmentValue(field, raw); } catch { throw new Error(`Environment ${name} is not a valid ${field.type} for policy ${policy.id}`); }
      }
      this.pins.set(policy.id, Object.freeze(pinned));
    }
    this.definitions = definitions;
    this.scopes.register({ id: POLICY_SCOPE, name: 'Product policies', publicAccess: false, isPublic: false,
      properties: policies.map(policy => ({ key: policy.id, name: policy.name ?? policy.id, type: 'json', defaultValue: undefined,
        description: 'Product policy {revision, values}', readonly: false, encrypted: false })) });
  }

  private definition(id: string): PolicyDefinition {
    const policy = this.definitions.get(id); if (!policy) throw new NotFoundException('Unknown policy'); return policy;
  }
  private configuration(tx: ApplicationTransaction): ConfigService { return new ConfigService(tx, undefined, this.scopes); }
  private async lock(tx: ApplicationTransaction, id: string): Promise<void> {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended(current_schema() || ':runtime.policy:' || $1, 0))::text AS locked", [id]);
  }
  /**
   * Structural corruption (not `{revision, values}`) is a 503. A saved key that the current
   * definition no longer declares, or whose value no longer validates (definition changed between
   * releases), is ignored so the default applies; the next save drops it. Only key names are logged.
   */
  private async read(tx: ApplicationTransaction, policy: PolicyDefinition): Promise<StoredPolicy> {
    const raw = await this.configuration(tx).get<unknown>(POLICY_SCOPE, policy.id);
    if (raw === undefined || raw === null) return { revision: 0, values: {} };
    if (!record(raw) || Object.keys(raw).some(key => !['revision', 'values'].includes(key)) || !Number.isSafeInteger(raw.revision)
      || Number(raw.revision) < 1 || !record(raw.values)) throw storageUnavailable();
    const values: Record<string, PolicyValue> = {}, ignored: string[] = [];
    for (const [key, value] of Object.entries(raw.values)) {
      const field = policy.fields.find(item => item.key === key);
      try { if (!field) throw new PolicyValueError(); values[key] = policyFieldValue(field, value); } catch { ignored.push(key); }
    }
    if (ignored.length) this.logger.warn(`Policy ${policy.id} ignores stale saved fields: ${ignored.join(', ')}`);
    return { revision: Number(raw.revision), values };
  }
  private resolve(policy: PolicyDefinition, stored: StoredPolicy): Resolved {
    const pinned = this.pins.get(policy.id) ?? {}, values: Record<string, PolicyValue> = {};
    for (const field of policy.fields)
      values[field.key] = Object.hasOwn(pinned, field.key) ? pinned[field.key]! : Object.hasOwn(stored.values, field.key) ? stored.values[field.key]! : field.default;
    return { revision: stored.revision, values: deepFreeze(values), saved: stored.values };
  }
  private load(policy: PolicyDefinition): Promise<Resolved> {
    const cached = this.cache.get(policy.id), now = Date.now();
    if (cached && cached.expires > now) return cached.value;
    const generation = this.generation.get(policy.id) ?? 0;
    const value = this.database.transaction(async tx => this.resolve(policy, await this.read(tx, policy)));
    this.cache.set(policy.id, { expires: now + this.ttlMs, value });
    // Never cache a failure; drop a result that a concurrent local save has superseded.
    value.then(() => { if ((this.generation.get(policy.id) ?? 0) !== generation && this.cache.get(policy.id)?.value === value) this.cache.delete(policy.id); },
      () => { if (this.cache.get(policy.id)?.value === value) this.cache.delete(policy.id); });
    return value;
  }
  private invalidate(id: string): void { this.generation.set(id, (this.generation.get(id) ?? 0) + 1); this.cache.delete(id); }

  /** Effective, frozen values of one policy (read-through, at most `POLICY_CACHE_TTL_MS` old). */
  async get<V extends PolicyValues = PolicyValues>(policy: string | PolicyDefinition<V>): Promise<V> {
    return (await this.load(this.definition(typeof policy === 'string' ? policy : policy.id))).values as V;
  }
  /** Ids of the registered policies, in declaration order. */
  ids(): string[] { return [...this.definitions.keys()]; }

  private projection(policy: PolicyDefinition, resolved: Resolved) {
    const pinned = this.pins.get(policy.id) ?? {};
    return { id: policy.id, name: policy.name ?? policy.id, labelKey: `policies.${policy.id}`, revision: resolved.revision,
      applyMode: 'hot' as const, appliesOn: 'next-request' as const,
      fields: policy.fields.map((field: PolicyField) => {
        const isPinned = Object.hasOwn(pinned, field.key), isSaved = Object.hasOwn(resolved.saved, field.key);
        return { key: field.key, type: field.type, labelKey: `policies.${policy.id}.${field.key}`,
          ...(field.label ? { label: field.label } : {}), ...(field.description ? { description: field.description } : {}),
          ...(field.options ? { options: field.options } : {}), ...(field.min !== undefined ? { min: field.min } : {}),
          ...(field.max !== undefined ? { max: field.max } : {}), ...(field.integer ? { integer: true } : {}),
          public: field.public === true, default: field.default, value: resolved.values[field.key],
          source: isPinned ? 'environment' as const : isSaved ? 'saved' as const : 'default' as const,
          pinnedByEnvironment: isPinned, ...(isPinned ? { environmentKey: policyEnvironmentKey(policy.id, field.key) } : {}) };
      }) };
  }
  /** Administrator view: always read from storage (bypasses the cache) so an editor sees the current revision. */
  async list() {
    const policies = await this.database.transaction(async tx => {
      const rows = []; for (const policy of this.definitions.values()) rows.push(this.projection(policy, this.resolve(policy, await this.read(tx, policy)))); return rows;
    });
    return { policies, externalRequests: false as const };
  }
  async view(id: string) {
    const policy = this.definition(id);
    return this.database.transaction(async tx => this.projection(policy, this.resolve(policy, await this.read(tx, policy))));
  }

  /** Only `public: true` fields, with revisions; the explicit allow-list for unauthenticated clients. */
  async publicConfig() {
    const policies: Record<string, { revision: number; values: Record<string, PolicyValue> }> = {};
    for (const policy of this.definitions.values()) {
      const exposed = policy.fields.filter(field => field.public === true);
      if (!exposed.length) continue;
      const resolved = await this.load(policy), values: Record<string, PolicyValue> = {};
      for (const field of exposed) values[field.key] = resolved.values[field.key]!;
      policies[policy.id] = { revision: resolved.revision, values };
    }
    return { policies };
  }

  private update(policy: PolicyDefinition, body: unknown): Update {
    if (!record(body) || Object.keys(body).some(key => !['expectedRevision', 'values'].includes(key)) || !Number.isSafeInteger(body.expectedRevision)
      || Number(body.expectedRevision) < 0 || !record(body.values)) throw new BadRequestException('Invalid policy update');
    const pinned = this.pins.get(policy.id) ?? {}, values: Update['values'] = {};
    for (const [key, value] of Object.entries(body.values)) {
      const field = policy.fields.find(item => item.key === key);
      if (!field) throw new BadRequestException('Unknown policy field');
      if (Object.hasOwn(pinned, key)) throw new BadRequestException(`${key} is pinned by the server environment`);
      // `null` removes the saved value so the declared default applies again.
      try { values[key] = value === null ? null : policyFieldValue(field, value); } catch (error) {
        throw new BadRequestException(error instanceof PolicyValueError ? error.message : 'Invalid policy value');
      }
    }
    return { expectedRevision: Number(body.expectedRevision), values };
  }
  async save(actorId: string, id: string, body: unknown) {
    if (!actorId) throw new BadRequestException('Authenticated policy operator is required');
    const policy = this.definition(id), update = this.update(policy, body);
    const result = await this.database.transaction(async tx => {
      await this.lock(tx, policy.id); const stored = await this.read(tx, policy);
      if (stored.revision !== update.expectedRevision) throw new ConflictException('Policy changed; reload before saving');
      const values: Record<string, PolicyValue> = { ...stored.values };
      for (const [key, value] of Object.entries(update.values)) { if (value === null) delete values[key]; else values[key] = value; }
      const same = (a: PolicyValue | undefined, b: PolicyValue | undefined) => JSON.stringify(a) === JSON.stringify(b);
      const changedFields = [...new Set([...Object.keys(values), ...Object.keys(stored.values)])].filter(key => !same(values[key], stored.values[key])).sort();
      if (!changedFields.length) return { saved: false, view: this.projection(policy, this.resolve(policy, stored)) };
      if (stored.revision >= Number.MAX_SAFE_INTEGER) throw new ConflictException('Policy revision limit reached');
      const next: StoredPolicy = { revision: stored.revision + 1, values }, resolved = this.resolve(policy, next);
      try { policy.validate?.(resolved.values); } catch (error) {
        throw new BadRequestException(error instanceof Error && error.message ? error.message : 'Policy values are inconsistent');
      }
      await this.configuration(tx).setProperties(POLICY_SCOPE, { [policy.id]: next });
      // Field names only: policies are not secrets, but the audit trail stays uniform with connection profiles.
      await tx.model('operationLogs').create({ data: { module: 'policy', action: 'update', status: 'SUCCESS', userId: actorId,
        targetId: policy.id, targetType: 'policy', method: 'PUT', path: `/management/policies/${policy.id}`,
        metadata: { revision: next.revision, changedFields, appliesOn: 'next-request' } } });
      return { saved: true, view: this.projection(policy, resolved) };
    });
    if (result.saved) this.invalidate(policy.id);
    return result.view;
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); for (const item of Object.values(value)) deepFreeze(item); }
  return value;
}
