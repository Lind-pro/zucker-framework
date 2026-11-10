/**
 * Product policy declarations. A policy is a small set of non-secret product switches (for example
 * "require e-mail verification" or "welcome credits") that an administrator can change at runtime.
 * A feature declares its policy in its own folder with `definePolicy` and the application passes the
 * exported definitions to `PolicyModule.forRoot({ policies })`.
 *
 * Policies are never secrets: they are stored in plain JSON, shown to `config:query` readers and, for
 * `public: true` fields, served unauthenticated by `GET /site/public/config`. A `secret` field type
 * is rejected at definition time; credentials belong in a connection profile.
 */
export type PolicyFieldType = 'boolean' | 'number' | 'text' | 'select' | 'json';
export type PolicyValue = boolean | number | string | null | PolicyValue[] | { [key: string]: PolicyValue };
export type PolicyValues = Readonly<Record<string, PolicyValue>>;

export interface PolicyField {
  /** camelCase key; also names the environment pin `POLICY_<ID>_<KEY>` (UPPER_SNAKE). */
  readonly key: string;
  readonly type: PolicyFieldType;
  readonly default: PolicyValue;
  /** Explicit allow-list for `GET /site/public/config`; omitted means private. */
  readonly public?: boolean;
  /** `number`: inclusive bounds. `text`: length bounds (characters). */
  readonly min?: number;
  readonly max?: number;
  /** `number`: require a safe integer. */
  readonly integer?: boolean;
  /** `select`: allowed values. */
  readonly options?: readonly string[];
  readonly label?: string;
  readonly description?: string;
}

export interface PolicyDefinition<V extends PolicyValues = PolicyValues> {
  /** kebab-case id, e.g. `account`, `ai-limits`. */
  readonly id: string;
  readonly name?: string;
  readonly fields: readonly PolicyField[];
  /**
   * Cross-field check of the complete effective values (defaults, saved and pinned merged). Throw to
   * reject a save; the message is returned to the administrator, so do not echo other policies' data.
   */
  // Method syntax keeps a typed definition assignable to `PolicyDefinition` (parameter bivariance).
  validate?(values: V): void;
}

export class PolicyValueError extends Error {}

const POLICY_ID = /^[a-z][a-z0-9-]{0,47}$/;
const FIELD_KEY = /^[a-z][a-zA-Z0-9]{0,47}$/;
const FIELD_TYPES: readonly string[] = ['boolean', 'number', 'text', 'select', 'json'];
const TEXT_LIMIT = 4096, JSON_LIMIT = 16 * 1024;
/** Text may contain line breaks and tabs, never other control characters. */
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/** Validates and normalizes one value against its field; throws `PolicyValueError` naming the key only. */
export function policyFieldValue(field: PolicyField, value: unknown): PolicyValue {
  const invalid = () => new PolicyValueError(`Invalid value for ${field.key}`);
  switch (field.type) {
    case 'boolean':
      if (typeof value !== 'boolean') throw invalid();
      return value;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value) || field.integer && !Number.isSafeInteger(value)
        || field.min !== undefined && value < field.min || field.max !== undefined && value > field.max) throw invalid();
      return value;
    case 'text':
      if (typeof value !== 'string' || CONTROL.test(value) || value.length > Math.min(field.max ?? TEXT_LIMIT, TEXT_LIMIT)
        || field.min !== undefined && value.length < field.min) throw invalid();
      return value;
    case 'select':
      if (typeof value !== 'string' || !field.options?.includes(value)) throw invalid();
      return value;
    case 'json': {
      let serialized: string | undefined;
      // The replacer sees every nested value: JSON.stringify would silently turn NaN/±Infinity into null.
      const finiteOnly = (_key: string, nested: unknown) => {
        if (typeof nested === 'number' && !Number.isFinite(nested)) throw invalid();
        return nested;
      };
      try { serialized = JSON.stringify(value, finiteOnly); } catch { throw invalid(); }
      if (serialized === undefined || serialized.length > JSON_LIMIT) throw invalid();
      // Round trip drops undefined/functions and normalizes the copy so it holds plain JSON only.
      const copy: unknown = JSON.parse(serialized);
      if (JSON.stringify(copy) !== serialized) throw invalid();
      return copy as PolicyValue;
    }
    default:
      throw invalid();
  }
}

/** Upper-snake environment name of a pinned field: `account` + `requireEmailVerification` → `POLICY_ACCOUNT_REQUIRE_EMAIL_VERIFICATION`. */
export function policyEnvironmentKey(policyId: string, fieldKey: string): string {
  return `POLICY_${policyId.replaceAll('-', '_').toUpperCase()}_${fieldKey.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()}`;
}

/** Parses an environment pin (always a string) into the field's type. */
export function parsePolicyEnvironmentValue(field: PolicyField, raw: string): PolicyValue {
  const value = raw.trim();
  switch (field.type) {
    case 'boolean':
      if (value !== 'true' && value !== 'false') throw new PolicyValueError(`Invalid value for ${field.key}`);
      return policyFieldValue(field, value === 'true');
    case 'number':
      if (!/^-?\d+(?:\.\d+)?$/.test(value)) throw new PolicyValueError(`Invalid value for ${field.key}`);
      return policyFieldValue(field, Number(value));
    case 'json':
      try { return policyFieldValue(field, JSON.parse(value)); } catch { throw new PolicyValueError(`Invalid value for ${field.key}`); }
    default:
      return policyFieldValue(field, value);
  }
}

/**
 * Checks the declaration once at module load: ids/keys, supported types (no `secret`), select options,
 * bounds, and that the defaults pass both field and cross-field validation.
 */
export function definePolicy<V extends PolicyValues = PolicyValues>(definition: PolicyDefinition<V>): PolicyDefinition<V> {
  const { id, fields } = definition;
  if (!POLICY_ID.test(id)) throw new Error(`Invalid policy id ${id}`);
  if (!fields.length) throw new Error(`Policy ${id} has no fields`);
  const keys = new Set<string>(), defaults: Record<string, PolicyValue> = {};
  for (const field of fields) {
    if (!FIELD_KEY.test(field.key) || keys.has(field.key)) throw new Error(`Invalid or duplicate field ${field.key} in policy ${id}`);
    if (!FIELD_TYPES.includes(field.type)) throw new Error(`Policy ${id} field ${field.key} has unsupported type ${String(field.type)}; policies never hold secrets`);
    if (field.type === 'select' && (!field.options?.length || new Set(field.options).size !== field.options.length)) throw new Error(`Policy ${id} select field ${field.key} needs distinct options`);
    if (field.min !== undefined && field.max !== undefined && field.min > field.max) throw new Error(`Policy ${id} field ${field.key} has min > max`);
    try { defaults[field.key] = policyFieldValue(field, field.default); } catch { throw new Error(`Policy ${id} field ${field.key} has an invalid default`); }
    keys.add(field.key);
  }
  try { definition.validate?.(defaults as V); } catch { throw new Error(`Policy ${id} defaults fail its validate()`); }
  return Object.freeze({ ...definition, fields: Object.freeze(fields.map(field => Object.freeze({ ...field }))) });
}

/** Concatenates feature policy arrays; ids must be unique. */
export function composePolicies(...groups: ReadonlyArray<readonly PolicyDefinition[]>): readonly PolicyDefinition[] {
  const all = groups.flat(), ids = new Set<string>();
  for (const policy of all) {
    if (ids.has(policy.id)) throw new Error(`Duplicate policy ${policy.id}`);
    ids.add(policy.id);
  }
  return Object.freeze(all);
}
